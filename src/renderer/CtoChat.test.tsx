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
  emitStreamAndFlush,
  resetStore,
  type Harness,
  type MockApi,
  type MockEventBus,
} from "./testHarness";
import { CtoChat } from "./CtoChat";
import { CtoPanel } from "./CtoPanel";
import type { CtoConversationState, CtoSubmissionProjection } from "../shared/api";

// Capture what the transcript receives. The inline question copy renders
// INSIDE the virtualized list, which jsdom (zero-height) renders empty — so
// a DOM text-count cannot see the double render. Assert the PROP instead.
const transcriptProps: Array<{ questions?: unknown[] }> = [];
vi.mock("./Transcript", () => ({
  Transcript: (props: { questions?: unknown[] }) => {
    transcriptProps.push(props);
    return null;
  },
}));

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

// A server-realistic queue PROJECTION — exactly what admission.list() emits
// after normalizeAdmissionPayload validated the stored record
// (src/server/ctoAdmission.mjs): the payload TEXT is stripped from listings,
// and sessionId+messageID are REQUIRED on every record that is not
// queued/cancelled (the validator rejects the rest), so this helper defaults
// them. Fixtures that violate these invariants describe states the server
// cannot produce — and green tests over them mean nothing.
function submission(
  id: string,
  status: CtoSubmissionProjection["status"],
  extra: Partial<CtoSubmissionProjection> = {},
): CtoSubmissionProjection {
  const s: CtoSubmissionProjection = {
    id,
    origin: "human",
    payloadHash: `hash_${id}`,
    status,
    createdAt: Date.now(),
    submitGeneration: GENERATION,
    ...extra,
  };
  if (s.status !== "queued" && s.status !== "cancelled") {
    if (s.sessionId === undefined) s.sessionId = SESSION;
    if (s.messageID === undefined) s.messageID = `msg_${id}`;
  }
  return s;
}

// Seed the transcript with the user message a dispatched record's messageID
// points at — the server-realistic situation for accepted/interrupt_pending
// records (the user message lands in the transcript when the turn starts).
function userTranscriptRows(refs: Array<{ messageID: string; text: string }>) {
  return refs.map((r) => ({
    info: { id: r.messageID, role: "user", sessionID: SESSION },
    parts: [{ type: "text", text: r.text }],
  }));
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

// Press the unknown-send bubble's Retry control and flush.
async function pressRetry(): Promise<void> {
  const retryBtn = Array.from(h!.container.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === "Retry send",
  );
  expect(retryBtn).not.toBeNull();
  await act(async () => {
    retryBtn!.click();
  });
  await h!.flush();
}

// Press the composer's Stop (Interrupt) control, flush, and return the
// recorded ctoConversationInterrupt calls for the assertions.
async function pressStop(): Promise<Array<Array<unknown>>> {
  const stop = h!.container.querySelector('button[aria-label="Interrupt"]');
  expect(stop).not.toBeNull();
  await act(async () => {
    (stop as HTMLButtonElement).click();
  });
  await h!.flush();
  return api!.calls.ctoConversationInterrupt ?? [];
}

// Press the unknown-send bubble's Dismiss control and flush.
async function pressDismissUnknown(): Promise<void> {
  const dismiss = Array.from(h!.container.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === "Dismiss unknown send",
  );
  expect(dismiss).not.toBeNull();
  await act(async () => {
    dismiss!.click();
  });
  await h!.flush();
}

// Mount over a MUTABLE queue holder with a submit that fails its FIRST call
// with `message` (the message chooses the failure class: definitive refusal
// vs unknown outcome), so later steps can swap the server truth.
async function mountFailingSubmit(
  holder: { current: CtoConversationState },
  message: string,
): Promise<Harness> {
  let failFirst = true;
  const mounted = mountCto(holder.current, {
    ctoConversationState: () => Promise.resolve(holder.current),
    ctoConversationSubmit: (input: { id?: string; text: string }) => {
      if (failFirst) {
        failFirst = false;
        return Promise.reject(new Error(message));
      }
      return Promise.resolve(receiptOf(input));
    },
  });
  h = mounted;
  await mounted.flush();
  return mounted;
}

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
    const q = emptyQueue();
    q.submissions = [submission("evt_q_other_client", "queued")];
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
    await pressRetry();
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
    await pressDismissUnknown();
    expect(h.text()).not.toContain("Outcome unknown — reconciling");
  });

  it("interrupt goes through ctoConversationInterrupt with the ADMISSION RECORD id — never an opencode abort", async () => {
    // SERVER-REALISTIC: an accepted record requires sessionId+messageID and
    // its user message is already in the transcript (the turn dispatched).
    const q = emptyQueue();
    q.submissions = [submission("evt_running_1", "accepted")];
    q.counts.unresolved = 1;
    h = mountCto(q, {
      opencodeMessages: () =>
        Promise.resolve(userTranscriptRows([{ messageID: "msg_evt_running_1", text: "run the deploy" }])),
    });
    await h.flush();
    await emitAndFlush(bus, h, {
      type: "session.status",
      properties: { sessionID: SESSION, status: "busy" },
    });
    const interrupts = await pressStop();
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
    q.submissions = [submission("sched_j1_min", "queued", { origin: "background" })];
    q.counts.queued.background = 1;
    q.droppedByPolicy = [
      { id: "sched_j0_min", origin: "background", createdAt: Date.now() - 60_000 },
    ];
    h = mountCto(q);
    await h.flush();
    // The loss is visible on the CLOSED toggle — without opening the panel.
    const toggle = Array.from(h.container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Work inspector"),
    );
    expect(toggle).not.toBeNull();
    expect(toggle!.textContent).toContain("1 dropped by policy");
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

  it("renders an uncertain abort as a PERMANENT admission hold — visible where the user is looking", async () => {
    // SERVER-REALISTIC (the previous fixture was not, which is why the hold
    // could render in a test yet never in production): an interrupt_pending
    // record always came from accepted, the merged validator REQUIRES
    // sessionId+messageID on it, and its user message IS already in the
    // transcript — exactly the state whose "visible turn covers it" skip made
    // the permanent hold invisible.
    const q = emptyQueue();
    q.submissions = [
      submission("evt_held_1", "interrupt_pending", {
        abortState: "uncertain",
        abortOutcomeReason: "abort_outcome_unknown",
        messageID: "msg_held_1",
      }),
    ];
    q.counts.unresolved = 1;
    h = mountCto(q, {
      opencodeMessages: () =>
        Promise.resolve(userTranscriptRows([{ messageID: "msg_held_1", text: "hold the line" }])),
    });
    await h.flush();
    // The contract-mandated phrasing (limitation 1a) — as a pinned bubble
    // above the composer (where the user is looking).
    expect(h.text()).toContain("Abort outcome unknown — admission held for this session");
    // The bubble is a STATUS AFFORDANCE, not a second copy of the message:
    // the transcript already renders the record's text (the transcript mock
    // here renders nothing, so any occurrence would be the bubble
    // duplicating it).
    expect(h.text()).not.toContain("hold the line");
    // The surrounding controls must not lie: nothing is running and the
    // pump dispatches nothing while held.
    //  - Stop is an idempotent no-op on the held record → hidden.
    expect(h.container.querySelector('button[aria-label="Interrupt"]')).toBeNull();
    //  - The footer does not claim "Working — sends queue up".
    expect(h.text()).toContain("Admission held — queued sends will not dispatch");
    expect(h.text()).not.toContain("Working — sends queue up");
    //  - The composer placeholder says the same.
    const ta = h.container.querySelector(
      'textarea[aria-label="Message the CTO"]',
    ) as HTMLTextAreaElement;
    expect(ta.placeholder).toContain("Admission is held");
  });

  it("Stop with only queued sends targets the MOST RECENT queued one and confirms the outcome", async () => {
    const q = emptyQueue();
    q.submissions = [submission("evt_q_old", "queued"), submission("evt_q_new", "queued")];
    q.counts.queued.human = 2;
    h = mountCto(q, {
      ctoConversationInterrupt: (input: { id: string }) =>
        Promise.resolve({ ok: true, id: input.id, status: "cancelled" }),
    });
    await h.flush();
    const interrupts = await pressStop();
    expect(interrupts.length).toBe(1);
    // Newest-first (live is reversed) — NOT the oldest via [length-1].
    expect((interrupts[0][0] as { id: string }).id).toBe("evt_q_new");
    // The outcome is confirmed visibly — not a silent no-op.
    expect(h.text()).toContain("Queued send cancelled — it will not run.");
  });

  it("a definitive refusal (binding unavailable) shows the server's message and restores the draft — never 'outcome unknown'", async () => {
    // The server message is the REAL wording of the binding-unavailable
    // refusal (the CtoAdmissionError.code is not transported over /rpc —
    // surfacing the message is the honest minimum).
    h = mountCto(emptyQueue(), {
      ctoConversationSubmit: () =>
        Promise.reject(
          new Error(
            "binding unavailable — refusing to admit against unresolved role identity: role identity unresolved",
          ),
        ),
    });
    await h.flush();
    await typeAndSubmit(h, "urgent ask");
    expect(h.text()).toContain("The CTO declined the send: binding unavailable");
    // A definitive no: nothing persisted, nothing to reconcile — the unknown
    // bubble with its forever-Retry would be a lie.
    expect(h.text()).not.toContain("Outcome unknown — reconciling");
    // The composer was optimistically cleared — the draft is genuinely back.
    const ta = h.container.querySelector(
      'textarea[aria-label="Message the CTO"]',
    ) as HTMLTextAreaElement;
    expect(ta.value).toBe("urgent ask");
  });

  it("a stale-generation send restores the draft after the rebind remount and says so", async () => {
    h = mountCto(emptyQueue(), {
      ctoConversationSubmit: () =>
        Promise.reject(
          new Error("stale generation: expected 3, current binding generation is 4"),
        ),
    });
    await h.flush();
    await typeAndSubmit(h, "rebind survivor");
    // The rebind remounts the conversation — the draft must actually be
    // restored, not merely claimed as kept.
    const ta = h.container.querySelector(
      'textarea[aria-label="Message the CTO"]',
    ) as HTMLTextAreaElement;
    expect(ta.value).toBe("rebind survivor");
    expect(h.text()).toContain("Your text is back in the composer");
  });

  it("Retry reuses the PENDING RECORD's id even after an intervening successful send", async () => {
    const seen: string[] = [];
    let failFirst = true;
    h = mountCto(emptyQueue(), {
      ctoConversationSubmit: (input: { id?: string; text: string }) => {
        seen.push(`${input.id}:${input.text}`);
        if (failFirst) {
          failFirst = false;
          return Promise.reject(new Error("network timeout"));
        }
        return Promise.resolve(receiptOf(input));
      },
    });
    await h.flush();
    await typeAndSubmit(h, "send A"); // times out → unknown A
    await typeAndSubmit(h, "send B"); // succeeds → clears the single-slot retryRef
    // Retry A: must reuse A's ORIGINAL id (from the pending record itself).
    // A fresh id could double-run a send the server actually accepted with a
    // lost response.
    await pressRetry();
    expect(seen.length).toBe(3);
    expect(seen[2]).toBe(seen[0]);
  });

  it("Retry is disabled — not a silent no-op — while a send is in flight", async () => {
    const hold = gate();
    let attempts = 0;
    h = mountCto(emptyQueue(), {
      ctoConversationSubmit: (input: { id?: string; text: string }) => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error("network timeout"));
        // The retry attempt hangs until the test releases it.
        return new Promise((_resolve) => {
          hold.resolve({ v: receiptOf(input) });
        });
      },
    });
    await h.flush();
    await typeAndSubmit(h, "first");
    const retry = () =>
      Array.from(h!.container.querySelectorAll("button")).find(
        (b) => b.getAttribute("aria-label") === "Retry send",
      ) as HTMLButtonElement | null;
    expect(retry()).not.toBeNull();
    await act(async () => {
      retry()!.click();
    });
    await h.flush();
    // In flight → the button is DISABLED (an enabled Retry mid-send would be
    // a no-op control: submitTurn early-returns on the busy guard).
    expect(retry()!.disabled).toBe(true);
    hold.resolve(undefined);
    await h.flush();
  });

  it("a pending permission ask stays visible while a send is in flight", async () => {
    const hold = gate();
    h = mountCto(emptyQueue(), {
      opencodePermissions: () =>
        Promise.resolve([
          {
            id: "perm_1",
            sessionID: SESSION,
            permission: "bash",
            patterns: ["deploy *"],
            metadata: { command: "deploy --prod" },
          },
        ]),
      ctoConversationSubmit: () =>
        new Promise((_resolve) => {
          hold.resolve({ v: receiptOf({ id: "held", text: "held" }) });
        }),
    });
    await h.flush();
    // The ask arrives the way the box delivers it: a permission.asked event
    // triggers the permissions refetch (the mock returns the pending ask).
    await emitAndFlush(bus, h, {
      type: "permission.asked",
      properties: { sessionID: SESSION, id: "perm_1" },
    });
    expect(h.text()).toContain("Run a shell command?");
    // A send goes out and hangs (the submit mock holds it) — the ask must
    // stay visible through the in-flight window (and forever under a hang).
    await typeAndSubmit(h, "while blocked");
    await h.flush();
    expect(h.text()).toContain("Run a shell command?");
    hold.resolve(undefined);
    await h.flush();
  });

  it("a pending question renders exactly once — pinned stack, not duplicated inline", async () => {
    h = mountCto();
    await h.flush();
    await emitStreamAndFlush(bus, h, {
      sub: "questions",
      sessionId: SESSION,
      payload: {
        questions: [
          {
            id: "q1",
            sessionID: SESSION,
            requestId: "que_1",
            questions: [
              {
                question: "Which migration path?",
                header: "Migration",
                options: [{ label: "Online", description: "no downtime" }],
                multiple: false,
              },
            ],
          },
        ],
      },
    });
    // The pinned stack renders the card; the transcript must receive NO
    // inline questions — each question renders ONCE (the ChatPanel precedent
    // filters inline questions for exactly this).
    expect(transcriptProps.at(-1)?.questions ?? []).toHaveLength(0);
    const occurrences = h.text().split("Which migration path?").length - 1;
    expect(occurrences).toBe(1);
  });

  it("a question dismiss reports its failure like a reply does", async () => {
    h = mountCto(emptyQueue(), {
      opencodeQuestionReject: () => Promise.reject(new Error("reject failed: gone")),
    });
    await h.flush();
    await emitStreamAndFlush(bus, h, {
      sub: "questions",
      sessionId: SESSION,
      payload: {
        questions: [
          {
            id: "q2",
            sessionID: SESSION,
            requestId: "que_2",
            questions: [
              {
                question: "Proceed without tests?",
                header: "Tests",
                options: [{ label: "Yes", description: "skip" }],
                multiple: false,
              },
            ],
          },
        ],
      },
    });
    const dismiss = Array.from(h.container.querySelectorAll("button")).find(
      (b) => b.getAttribute("title") === "Dismiss this question",
    );
    expect(dismiss).not.toBeNull();
    await act(async () => {
      dismiss!.click();
    });
    await h.flush();
    expect(h.text()).toContain("reject failed: gone");
  });

  it("opens even if the IntersectionObserver never fires (bounded fallback, no eternal spinner)", async () => {
    class NeverObservable {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    }
    (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
      NeverObservable;
    try {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      h = mountCto();
      await h.flush();
      // The observer never reports — the open has NOT fired yet.
      expect(api.calls.ctoConversationOpen?.length ?? 0).toBe(0);
      vi.advanceTimersByTime(5_100);
      await h.flush();
      expect(api.calls.ctoConversationOpen?.length ?? 0).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
      delete (window as unknown as { IntersectionObserver?: unknown })
        .IntersectionObserver;
    }
  });

  it("a restored draft never replays over what the user has since typed — a rebind keeps their text", async () => {
    // The reviewer's exact sequence: definitive decline → restore → the user
    // replaces the draft → one rebind remounts → the user's text survives.
    const holder = { current: emptyQueue() };
    h = await mountFailingSubmit(
      holder,
      "binding unavailable — refusing to admit against unresolved role identity: x",
    );
    await typeAndSubmit(h, "OLD DRAFT");
    const ta = () =>
      h!.container.querySelector(
        'textarea[aria-label="Message the CTO"]',
      ) as HTMLTextAreaElement;
    // Restored after the decline.
    expect(ta().value).toBe("OLD DRAFT");
    // The user replaces it with their own text.
    await act(async () => {
      typeInto(ta(), "NEW TEXT");
    });
    await h.flush();
    expect(ta().value).toBe("NEW TEXT");
    // One rebind (another device) remounts the conversation.
    const rebound = emptyQueue();
    rebound.binding = { sessionId: "ses_cto_2", generation: 4 };
    holder.current = rebound;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await h.flush();
    // The user's text survives the remount — no stale draft replay.
    expect(ta().value).toBe("NEW TEXT");
  });

  it("a refused-abort record is not an interrupt target — no dead Stop, no false ack", async () => {
    // SERVER-REALISTIC: abortState "refused" keeps the record interrupt_pending
    // for the rest of a still-running turn (settle needs turn-end proof), and
    // the server's interrupt on it is the IDEMPOTENT NO-OP branch — it returns
    // the prior status and issues NO new attempt. Stop must not be rendered,
    // and nothing may affirm an abort that was never issued.
    const q = emptyQueue();
    q.submissions = [
      submission("evt_refused_1", "interrupt_pending", {
        abortState: "refused",
        abortError: "Session not found",
        messageID: "msg_refused_1",
      }),
    ];
    q.counts.unresolved = 1;
    h = mountCto(q, {
      opencodeMessages: () =>
        Promise.resolve(userTranscriptRows([{ messageID: "msg_refused_1", text: "deploy" }])),
    });
    await h.flush();
    expect(h.container.querySelector('button[aria-label="Interrupt"]')).toBeNull();
    // The hold copy still tells the truth (the pump holds for ANY unresolved
    // record) — without claiming an action the server did not perform.
    expect(h.text()).toContain("Admission held");
    expect(h.text()).not.toContain("Interrupt requested");
  });

  it("a dismissed unknown id does not suppress the LATER permanent-hold bubble for the same record", async () => {
    // Sequence the server can produce: send X times out (unknown) → the user
    // dismisses the unknown guess → reconcile proves X was accepted → the
    // user interrupts → the abort outcome can't be proven → the SAME record
    // id is now the PERMANENT hold. The hold must render.
    const holder = { current: emptyQueue() };
    h = await mountFailingSubmit(holder, "network timeout");
    await typeAndSubmit(h, "the send"); // times out → unknown bubble
    const submitId = (api.calls.ctoConversationSubmit?.[0]?.[0] as { id: string }).id;
    await pressDismissUnknown();
    expect(h.text()).not.toContain("Outcome unknown — reconciling");
    // Reconcile: the SAME record is now the uncertain-abort hold. Its user
    // message is in the transcript (server-realistic for a dispatched record).
    const held = emptyQueue();
    held.submissions = [
      submission(submitId, "interrupt_pending", {
        abortState: "uncertain",
        abortOutcomeReason: "abort_outcome_unknown",
        messageID: "msg_the_send",
      }),
    ];
    held.counts.unresolved = 1;
    holder.current = held;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await h.flush();
    expect(h.text()).toContain("Abort outcome unknown — admission held for this session");
  });

  it("held + a still-running turn says BOTH: the hold, and that the turn can no longer be interrupted", async () => {
    const q = emptyQueue();
    q.submissions = [
      submission("evt_held_run_1", "interrupt_pending", {
        abortState: "uncertain",
        abortOutcomeReason: "abort_outcome_unknown",
        messageID: "msg_held_run_1",
      }),
    ];
    q.counts.unresolved = 1;
    h = mountCto(q, {
      opencodeMessages: () =>
        Promise.resolve(userTranscriptRows([{ messageID: "msg_held_run_1", text: "run it" }])),
    });
    await h.flush();
    // The turn is STILL RUNNING — an uncertain abort means the abort may not
    // have landed. (Running arrives via the box stream's `running` sub, the
    // same envelope the sidebar uses.)
    await emitStreamAndFlush(bus, h, {
      sub: "running",
      sessionId: SESSION,
      payload: { running: true },
    });
    // Both truths: the hold blocks dispatch AND the running turn has become
    // unstoppable (Stop is hidden — no dead control, no false promise).
    expect(h.text()).toContain("the running turn can no longer be interrupted");
    expect(h.text()).toContain("will not dispatch");
    expect(h.container.querySelector('button[aria-label="Interrupt"]')).toBeNull();
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
