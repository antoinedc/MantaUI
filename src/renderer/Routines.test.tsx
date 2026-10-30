// @vitest-environment jsdom
//
// Routines screens against the real demo store (the same fixture the visual
// registry draws): what the page shows, and that every control calls the box
// and reports the result (spec §10).

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { installMockApi, mount, resetStore, buttonByText, type Harness } from "./testHarness";
import { createRoutinesStore, ROUTINES_T0 } from "./api/demoRoutines";
import { RoutinesPane } from "./RoutinesPane";
import { RoutineEditor } from "./RoutineEditor";
import { RoutineRunContext, type RoutineRunContextValue } from "./routineRunContext";
import { RoutineReportCard, RoutineToolCard, routineHeaderChrome } from "./RoutineRunParts";
import { RoutineDetail } from "./RoutineDetail";
import { RoutinesRoot, type RoutinesView } from "./RoutinesRoot";
import { Popover } from "./Popover";
import { Modal } from "./Modal";
import { ShowMore } from "./RoutinesParts";
import { ScheduledTasksCard } from "./PanelCards";
import type { ScheduledJob } from "../shared/types";
import { useStore } from "./store";
import { pinDemoClock } from "./clock";
import type { RoutinesSummary } from "../shared/routines";

async function click(h: Harness, el: Element | null) {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await h.flush();
}

function toasts(): string[] {
  const st = useStore.getState() as unknown as { appToasts?: { message: unknown }[] };
  return (st.appToasts ?? []).map((t) => String(t.message));
}

describe("Routines", () => {
  let h: Harness | null = null;
  let summary: RoutinesSummary;
  const store = createRoutinesStore();
  beforeEach(async () => {
    resetStore();
    pinDemoClock(ROUTINES_T0);
    summary = await store.summary();
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function mountPane(over: Partial<Parameters<typeof RoutinesPane>[0]> = {}, api: Record<string, unknown> = {}) {
    installMockApi(api);
    const props = {
      summary,
      error: null,
      reload: vi.fn(() => Promise.resolve()),
      onOpenRoutine: vi.fn(),
      onOpenRun: vi.fn(),
      onOpenTranscript: vi.fn(),
      onNewRoutine: vi.fn(),
      ...over,
    };
    h = mount(<RoutinesPane {...props} />);
    return props;
  }

  it("draws the four sections from the summary, eight routines in the table, no follow-ups section", () => {
    mountPane();
    const text = h!.text();
    for (const t of ["Needs you", "Unread", "Running now", "Your routines"]) {
      expect(text.toLowerCase()).toContain(t.toLowerCase());
    }
    expect(text.toLowerCase()).not.toContain("follow-ups in a chat");
    expect(h!.container.querySelector(".manta-routines-followups")).toBeNull();
    expect(h!.container.querySelectorAll(".manta-routines-table [role=button]").length).toBe(8);
    expect(text).not.toMatch(/findings/i);
    expect(text).toContain("14 bug reports are older than 90 days");
    expect(text).toContain("Tomorrow 9:00");
    expect(text).toContain("Weekdays · 9:00");
  });

  it("omits sections with nothing to show", () => {
    mountPane({ summary: { ...summary, needs: [], findings: [], running: [], waiting: [], followups: [], unread: 0, needsYou: 0 } });
    expect(h!.container.querySelector(".manta-routines-needs")).toBeNull();
    expect(h!.container.querySelector(".manta-routines-findings")).toBeNull();
    expect(h!.container.querySelector(".manta-routines-queue")).toBeNull();
    expect(h!.container.querySelector(".manta-routines-table")).toBeTruthy();
  });

  it("shows the empty state when there are no routines", () => {
    mountPane({ summary: { ...summary, routines: [], lastRuns: {} } });
    expect(h!.text()).toContain("No routines yet");
  });

  it("opens a routine from its row and a run from a finding", async () => {
    const p = mountPane();
    await click(h!, h!.container.querySelector(".manta-routines-table [role=button]"));
    expect(p.onOpenRoutine).toHaveBeenCalledWith("a1b2c3d4");
    await click(h!, h!.container.querySelector(".manta-routines-findings [role=button]"));
    expect(p.onOpenRun).toHaveBeenCalledWith("run_dg_23", expect.objectContaining({ id: "run_dg_23" }));
  });

  it("Answer opens the transcript of the run that is waiting, not the routine page", async () => {
    const p = mountPane();
    await click(h!, buttonByText(h!, "Answer"));
    expect(p.onOpenTranscript).toHaveBeenCalledWith("run_tr_9");
    expect(p.onOpenRun).not.toHaveBeenCalled();
  });

  it("a run that reported has no pill in the routines table", () => {
    mountPane();
    const row = [...h!.container.querySelectorAll(".manta-routines-table [role=button]")].find((r) => r.textContent?.includes("Daily analytics digest"));
    expect(row?.textContent).toContain("Today 9:04");
    expect(row?.textContent).not.toMatch(/findings|nothing new|done/i);
  });

  it("Mark all read calls the box, reloads and says how many it marked", async () => {
    const routinesMarkRead = vi.fn(() => Promise.resolve({ updated: 3 }));
    const p = mountPane({}, { routinesMarkRead });
    await click(h!, buttonByText(h!, "Mark all read"));
    expect(routinesMarkRead).toHaveBeenCalledWith("all");
    expect(p.reload).toHaveBeenCalled();
    expect(toasts().join(" ")).toContain("Marked 3 reports read");
  });

  it("a failing action surfaces an error toast instead of failing silently", async () => {
    mountPane({}, { routinesMarkRead: () => Promise.reject(new Error("box offline")) });
    await click(h!, buttonByText(h!, "Mark all read"));
    expect(toasts().join(" ")).toContain("box offline");
  });

  it("the toggle pauses a routine through routines:update", async () => {
    const routinesUpdate = vi.fn((_id: string, _p: unknown) => Promise.resolve({}));
    mountPane({}, { routinesUpdate });
    const sw = h!.container.querySelector('[aria-label="Enable Daily analytics digest"]') as HTMLElement;
    await click(h!, sw);
    expect(routinesUpdate).toHaveBeenCalledWith("a1b2c3d4", { enabled: false });
  });

  describe("the editor", () => {
    function mountEditor(api: Record<string, unknown> = {}) {
      installMockApi(api);
      useStore.setState({ projects: [{ tmuxSession: "ronda", defaultCwd: "/home/dev/projects/ronda", attached: true, windows: [] }] } as never);
      const props = { onClose: vi.fn(), onSaved: vi.fn(), onTestRun: vi.fn() };
      h = mount(<RoutineEditor open routine={null} tz="Europe/Paris" {...props} />);
      return props;
    }
    // The editor is a Modal (portalled to document.body), so queries go through the document.
    const docButton = (text: string) =>
      [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
    const field = (id: string) => document.body.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement;
    async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      await act(async () => {
        Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }

    it("Create stays disabled until name and instructions are filled (the folder defaults to the first project)", async () => {
      mountEditor();
      await h!.flush();
      expect(docButton("Create routine")?.disabled).toBe(true);
      await type(field("routine-name"), "Digest");
      expect(docButton("Create routine")?.disabled).toBe(true);
      await type(field("routine-prompt"), "Summarize yesterday");
      // The folder defaults to the first project's, so the form is now complete.
      expect(docButton("Create routine")?.disabled).toBe(false);
    });

    it("saves the form as the cron the schedule means", async () => {
      const routinesCreate = vi.fn((input: unknown) => Promise.resolve({ id: "11112222", name: (input as { name: string }).name }));
      const props = mountEditor({ routinesCreate });
      await h!.flush();
      await type(field("routine-name"), "Digest");
      await type(field("routine-prompt"), "Summarize yesterday");
      await act(async () => {
        useStore.setState({});
      });
      // The folder comes from the first project; pick Weekdays at 08:30.
      await click(h!, docButton("Weekdays") ?? null);
      await type(field("routine-time"), "08:30");
      await click(h!, docButton("Create routine") ?? null);
      expect(routinesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Digest", prompt: "Summarize yesterday", cron: "30 8 * * 1-5", access: "read", notify: "findings", directory: "/home/dev/projects/ronda" }),
      );
      expect(props.onSaved).toHaveBeenCalled();
    });

    it("Test run now saves the routine PAUSED, queues one run and hands its id to the caller", async () => {
      const routinesCreate = vi.fn((input: unknown) => Promise.resolve({ id: "11112222", name: "Digest", ...(input as object) }));
      const routinesRunNow = vi.fn(() => Promise.resolve({ run: { id: "run_x" }, alreadyQueued: false }));
      const props = mountEditor({ routinesCreate, routinesRunNow });
      await h!.flush();
      await type(field("routine-name"), "Digest");
      await type(field("routine-prompt"), "Summarize yesterday");
      await click(h!, docButton("Test run now") ?? null);
      expect(routinesCreate).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
      expect(routinesRunNow).toHaveBeenCalledWith("11112222");
      expect(props.onTestRun).toHaveBeenCalledWith(expect.anything(), "run_x");
    });

    it("an invalid schedule keeps Create disabled and says why", async () => {
      mountEditor();
      await h!.flush();
      await type(field("routine-name"), "Digest");
      await type(field("routine-prompt"), "Summarize yesterday");
      await click(h!, docButton("Custom") ?? null);
      await type(field("routine-cron"), "* *");
      expect(docButton("Create routine")?.disabled).toBe(true);
      expect(document.body.textContent).toContain("five fields");
    });
  });

  describe("the cards a routine tool call draws in the transcript", () => {
    const part = (tool: string, input: Record<string, unknown>, output = "") => ({ type: "tool", tool, state: { status: "completed", input, output } });

    it("routine_create becomes a card whose Run now queues the routine", async () => {
      const routinesRunNow = vi.fn(() => Promise.resolve({ run: {}, alreadyQueued: false }));
      const routinesGet = vi.fn(() => Promise.reject(new Error("gone")));
      installMockApi({ routinesRunNow, routinesGet });
      h = mount(
        <RoutineToolCard
          part={part("routine_create", { name: "Digest", cron: "0 9 * * 1-5", access: "read", notify: "findings", memory: "a\nb" }, 'Routine "Digest" created. Id 0a1b2c3d. Runs 0 9 * * 1-5.')}
        />,
      );
      await h.flush();
      expect(h.text()).toContain("Routine created");
      expect(h.text()).toContain("Weekdays at 9:00");
      expect(h.text()).toContain("(2 lines)");
      await click(h, buttonByText(h, "Run now"));
      expect(routinesRunNow).toHaveBeenCalledWith("0a1b2c3d");
    });

    it("a routine_report inside a run is only a pointer; the pinned tail card carries the report", async () => {
      installMockApi();
      const run = (await store.runGet("run_dg_23")).run;
      const routine = (await store.get("a1b2c3d4")).routine;
      const onFollowUp = vi.fn();
      const ctx: RoutineRunContextValue = { run, routine, prevRunId: null, nextRunId: null, onNavigate: vi.fn(), onKeep: vi.fn(), onBack: vi.fn(), onOpenRoutine: vi.fn(), onFollowUp, firstUserMessageId: null };
      h = mount(
        <RoutineRunContext.Provider value={ctx}>
          <RoutineToolCard part={part("routine_report", { outcome: "findings" })} />
        </RoutineRunContext.Provider>,
      );
      expect(h.text()).toContain("Filed its report");
      expect(h.text()).not.toContain("Signups up 18% week over week");
      h.unmount();
      h = mount(
        <RoutineRunContext.Provider value={ctx}>
          <RoutineReportCard />
        </RoutineRunContext.Provider>,
      );
      expect(h.text()).not.toMatch(/findings/i);
      expect(h.text()).toContain("Signups up 18% week over week");
      expect(h.text()).toContain("Notified you at 9:04");
      await click(h, buttonByText(h, "Follow up"));
      expect(onFollowUp).toHaveBeenCalled();
    });

    it("a routine tool that has not completed is left to the generic tool card", () => {
      installMockApi();
      h = mount(<RoutineToolCard part={{ type: "tool", tool: "routine_create", state: { status: "running" } }} />);
      expect(h.text()).toBe("");
    });
  });
});

describe("follow-ups: Make it a routine lives in the chat's ⏰ card", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });
  const job = (over: Partial<ScheduledJob>): ScheduledJob => ({
    id: "job00001",
    cron: "0 9 * * 1-5",
    prompt: "check deploy",
    recurring: true,
    label: "",
    kind: "prompt",
    sessionID: "ses_1",
    directory: "/x",
    createdAt: 0,
    lastFiredMinute: null,
    ...over,
  });

  it("offers it on a recurring prompt follow-up only, and hands the job to the caller", async () => {
    installMockApi();
    const onConvert = vi.fn();
    const jobs = [job({}), job({ id: "job00002", recurring: false }), job({ id: "job00003", kind: "notify" }), job({ id: "job00004", routineId: "abcd1234" })];
    h = mount(<ScheduledTasksCard jobs={jobs} error={null} onDelete={vi.fn()} onClose={vi.fn()} onConvert={onConvert} />);
    const buttons = [...h.container.querySelectorAll("button")].filter((b) => b.textContent === "Make it a routine");
    expect(buttons.length).toBe(1);
    await click(h, buttons[0]);
    expect(onConvert).toHaveBeenCalledWith(expect.objectContaining({ id: "job00001" }));
  });

  it("has no button when the caller doesn't support converting", () => {
    installMockApi();
    h = mount(<ScheduledTasksCard jobs={[job({})]} error={null} onDelete={vi.fn()} onClose={vi.fn()} />);
    expect(h.text()).not.toContain("Make it a routine");
  });
});

describe("ShowMore", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
    vi.restoreAllMocks();
  });

  it("shows no toggle when the text fits", () => {
    installMockApi();
    h = mount(<ShowMore lines={3}>short</ShowMore>);
    expect(h.text()).not.toContain("Show more");
  });

  it("clamps overflowing text and toggles Show more / Show less", async () => {
    installMockApi();
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
    h = mount(<ShowMore lines={3}>long text</ShowMore>);
    const clamp = h.container.firstElementChild!.firstElementChild as HTMLElement;
    expect(clamp.style.overflow).toBe("hidden");
    await click(h, buttonByText(h, "Show more"));
    expect(clamp.style.overflow).toBe("");
    await click(h, buttonByText(h, "Show less"));
    expect(clamp.style.overflow).toBe("hidden");
  });
});

describe("a run's header", () => {
  it("has a Close button that goes back to the routine page with this run selected", async () => {
    installMockApi();
    const s = createRoutinesStore();
    const sum = await s.summary();
    const run = sum.lastRuns[sum.routines[0].id]!;
    const onBack = vi.fn();
    const onOpenRoutine = vi.fn();
    const chrome = routineHeaderChrome({
      run,
      routine: sum.routines[0],
      prevRunId: null,
      nextRunId: null,
      onNavigate: vi.fn(),
      onKeep: vi.fn(),
      onBack,
      onOpenRoutine,
      onFollowUp: vi.fn(),
    });
    const h = mount(<>{chrome.lead}</>);
    await click(h, h.container.querySelector('[aria-label="Close run"]'));
    expect(onOpenRoutine).toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    h.unmount();
    const crumb = mount(<>{chrome.crumb}</>);
    await click(crumb, buttonByText(crumb, "Routines"));
    expect(onBack).toHaveBeenCalled();
    await click(crumb, buttonByText(crumb, sum.routines[0].name));
    expect(onOpenRoutine).toHaveBeenCalledTimes(2);
    crumb.unmount();
  });
});

describe("a menu opened from inside a modal", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("sits above the modal, and Escape closes the menu without closing the modal", async () => {
    installMockApi();
    const onDismiss = vi.fn();
    const onClose = vi.fn();
    function Host() {
      const ref = { current: null as HTMLButtonElement | null };
      return (
        <Modal open onDismiss={onDismiss} label="Host">
          <button ref={(el) => void (ref.current = el)}>anchor</button>
          <Popover open onClose={onClose} anchorRef={ref as React.RefObject<HTMLElement>} ariaLabel="menu">
            <input aria-label="search" />
          </Popover>
        </Modal>
      );
    }
    h = mount(<Host />);
    await h.flush();
    const surface = document.body.querySelector('[aria-label="menu"]') as HTMLElement;
    expect(surface.style.zIndex).toBe("55");
    const input = surface.querySelector("input") as HTMLInputElement;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe("the routine page — the run inbox", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  const DIGEST = "a1b2c3d4";
  async function mountDetail(over: { routineId?: string; runId?: string; api?: Record<string, unknown>; store?: ReturnType<typeof createRoutinesStore> } = {}) {
    pinDemoClock(ROUTINES_T0);
    resetStore();
    const store = over.store ?? createRoutinesStore();
    const routinesGet = vi.fn((id: string, opts?: { beforeSeq?: number; findingsOnly?: boolean }) => store.get(id, opts));
    const routinesMarkRead = vi.fn((ids: string[] | "all") => store.markRead(ids));
    const routinesKeepInSidebar = vi.fn(() => Promise.resolve({ tmuxSession: "ronda", windowIndex: 3, sessionID: "ses_run" }));
    const tmuxSelectWindow = vi.fn(() => Promise.resolve());
    const routinesRunNow = vi.fn((id: string) => store.runNow(id));
    installMockApi({ routinesGet, routinesRunGet: store.runGet, routinesMarkRead, routinesKeepInSidebar, tmuxSelectWindow, routinesRunNow, ...over.api });
    const props = {
      routineId: over.routineId ?? DIGEST,
      summary: await store.summary(),
      runId: over.runId,
      onBack: vi.fn(),
      onSelectRun: vi.fn(),
      onOpenTranscript: vi.fn(),
      onClosePane: vi.fn(),
      onEdit: vi.fn(),
      onMoveToChat: vi.fn(),
      onChanged: vi.fn(),
    };
    h = mount(<RoutineDetail {...props} />);
    await h.flush();
    await h.flush();
    return { props, store, routinesGet, routinesMarkRead, routinesKeepInSidebar, tmuxSelectWindow, routinesRunNow };
  }
  const reading = () => h!.container.querySelector(".manta-routines-reading") as HTMLElement;
  const list = () => h!.container.querySelector(".manta-routines-runlist") as HTMLElement;
  const options = () => [...list().querySelectorAll('[role="option"]')] as HTMLElement[];
  const selectedOption = () => options().find((o) => o.getAttribute("aria-selected") === "true");
  const option = (text: string) => options().find((o) => o.textContent?.includes(text)) as HTMLElement | undefined;
  const readingButton = (text: string) => [...reading().querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
  async function key(el: Element, k: string) {
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    });
    await h!.flush();
  }

  it("opens on the newest unread run: its report in the reading pane, read on arrival, the choice kept in the view", async () => {
    const m = await mountDetail();
    expect(selectedOption()?.textContent).toContain("Signups up 18% week over week");
    expect(reading().textContent).toContain("Safari 17");
    expect(reading().textContent).toContain("Notified you at 9:04");
    expect(reading().textContent).toContain("Memory updated · +");
    expect(m.routinesMarkRead).toHaveBeenCalledWith(["run_dg_23"]);
    expect(m.props.onSelectRun).toHaveBeenCalledWith("run_dg_23");
    expect(m.props.onChanged).toHaveBeenCalled();
    // The unread dot goes away once it is read; the selection does not move.
    expect(selectedOption()?.textContent).toContain("Signups up 18% week over week");
    expect(selectedOption()?.querySelector(".invisible")).toBeTruthy();
    expect(h!.text()).not.toMatch(/findings/i);
  });

  it("header carries Edit / Pause / Run now; the page is a list and a reading pane", async () => {
    const m = await mountDetail();
    expect(h!.container.querySelector(".manta-routines-runlist")).toBeTruthy();
    expect(h!.container.querySelector(".manta-routines-reading")).toBeTruthy();
    expect(options()[0].textContent).toContain("About this routine");
    await click(h!, buttonByText(h!, "Run now"));
    expect(m.routinesRunNow).toHaveBeenCalledWith(DIGEST);
    await click(h!, buttonByText(h!, "Edit"));
    expect(m.props.onEdit).toHaveBeenCalled();
  });

  it("selecting another run shows it and reports the selection; a quiet run is muted and has no pill", async () => {
    const m = await mountDetail();
    const quiet = option("All metrics within normal range")!;
    expect(quiet.textContent).not.toMatch(/nothing new/i);
    expect(quiet.querySelector(".text-text-faint.font-normal")).toBeTruthy();
    await click(h!, quiet);
    expect(m.props.onSelectRun).toHaveBeenLastCalledWith("run_dg_22");
    expect(selectedOption()).toBe(option("All metrics within normal range"));
    expect(reading().textContent).toContain("All metrics within normal range");
    expect(reading().textContent).toContain("Filed quietly");
  });

  it("See transcript opens the run's transcript; Follow up keeps it in the sidebar and opens it", async () => {
    const m = await mountDetail();
    await click(h!, readingButton("See transcript") ?? null);
    expect(m.props.onOpenTranscript).toHaveBeenCalledWith("run_dg_23");
    await click(h!, readingButton("Follow up") ?? null);
    await h!.flush();
    expect(m.routinesKeepInSidebar).toHaveBeenCalledWith("run_dg_23");
    expect(m.props.onClosePane).toHaveBeenCalled();
    expect(m.tmuxSelectWindow).toHaveBeenCalledWith({ sessionName: "ronda", windowIndex: 3 });
  });

  it("a failed run shows its error with the danger label and the same two actions", async () => {
    await mountDetail({ runId: "run_dg_18" });
    expect(reading().textContent).toContain("PostHog returned 401");
    expect(reading().textContent).toContain("Failed");
    expect(readingButton("See transcript")).toBeTruthy();
    expect(readingButton("Follow up")).toBeTruthy();
    expect(option("PostHog returned 401")?.textContent).toContain("Failed");
  });

  it("a running run says how long, and Watch transcript opens it", async () => {
    const m = await mountDetail({ routineId: "d4e5f6a7", runId: "run_dd_12" });
    expect(reading().textContent).toContain("Running for 3m 4");
    expect(reading().textContent).toContain("started 9:57");
    await click(h!, readingButton("Watch transcript") ?? null);
    expect(m.props.onOpenTranscript).toHaveBeenCalledWith("run_dd_12");
  });

  it("a run that needs you shows the question; Answer opens the transcript", async () => {
    const m = await mountDetail({ routineId: "b2c3d4e5", runId: "run_tr_9" });
    expect(reading().textContent).toContain("14 bug reports are older than 90 days");
    await click(h!, readingButton("Answer") ?? null);
    expect(m.props.onOpenTranscript).toHaveBeenCalledWith("run_tr_9");
  });

  it("a queued run says its place in line and offers no action", async () => {
    await mountDetail({ routineId: "e5f6a7b8", runId: "run_da_31" });
    expect(reading().textContent).toContain("Waiting in line — #2");
    expect(reading().querySelector("button")).toBeNull();
  });

  it("About shows the routine: memory, instructions, settings", async () => {
    await mountDetail({ runId: "about" });
    expect(selectedOption()?.textContent).toContain("About this routine");
    expect(reading().querySelector(".manta-routines-memory")).toBeTruthy();
    expect(reading().textContent).toContain("What it remembers");
    expect(reading().textContent).toContain("Instructions");
    expect(reading().textContent).toContain("Missed runs");
    expect(reading().textContent).toContain("Notify when there's news");
  });

  it("with no runs yet it opens on About", async () => {
    const store = createRoutinesStore();
    const m = await mountDetail({ store, api: { routinesGet: () => store.get(DIGEST).then((d) => ({ ...d, runs: [], hasMore: false })) } });
    expect(selectedOption()?.textContent).toContain("About this routine");
    expect(m.props.onSelectRun).toHaveBeenCalledWith("about");
    expect(list().textContent).toContain("No runs yet");
  });

  it("↑/↓ and j/k move the selection through About and the runs", async () => {
    const m = await mountDetail();
    expect(list().getAttribute("role")).toBe("listbox");
    expect(list().tabIndex).toBe(0);
    await key(list(), "ArrowDown");
    expect(m.props.onSelectRun).toHaveBeenLastCalledWith("run_dg_22");
    expect(selectedOption()).toBe(option("All metrics within normal range"));
    await key(list(), "j");
    expect(m.props.onSelectRun).toHaveBeenLastCalledWith("run_dg_21");
    await key(list(), "ArrowUp");
    await key(list(), "k");
    expect(m.props.onSelectRun).toHaveBeenLastCalledWith("run_dg_23");
    await key(list(), "k");
    expect(m.props.onSelectRun).toHaveBeenLastCalledWith("about");
    await key(list(), "k");
    expect(selectedOption()?.textContent).toContain("About this routine");
  });

  it("'Hide quiet runs' asks the box for the runs that matter and flips to 'Show all'", async () => {
    const m = await mountDetail();
    expect(buttonByText(h!, "Show all")).toBeNull();
    await click(h!, buttonByText(h!, "Hide quiet runs"));
    expect(m.routinesGet).toHaveBeenLastCalledWith(DIGEST, expect.objectContaining({ findingsOnly: true }));
    expect(buttonByText(h!, "Show all")).toBeTruthy();
    expect(h!.text()).not.toMatch(/findings/i);
  });

  it("a requested run older than the loaded page is fetched and shown", async () => {
    const store = createRoutinesStore();
    const m = await mountDetail({
      store,
      runId: "run_dg_17",
      api: { routinesGet: (id: string) => store.get(id).then((d) => ({ ...d, runs: d.runs.filter((r) => r.id !== "run_dg_17") })) },
    });
    expect(m.props.onSelectRun).not.toHaveBeenCalled();
    expect(reading().textContent).toContain("All metrics within normal range");
  });
});

describe("RoutinesRoot routing", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  async function mountRoot(view: Exclude<RoutinesView, null>, api: Record<string, unknown> = {}) {
    pinDemoClock(ROUTINES_T0);
    resetStore();
    const store = createRoutinesStore();
    installMockApi({ routinesRunGet: store.runGet, routinesGet: store.get, routinesMarkRead: store.markRead, ...api });
    const setView = vi.fn();
    h = mount(<RoutinesRoot view={view} setView={setView} summary={await store.summary()} error={null} reload={() => Promise.resolve()} />);
    await h.flush();
    return setView;
  }

  it("an Unread row opens its routine page with that run selected", async () => {
    const setView = await mountRoot({ page: "list" });
    await click(h!, h!.container.querySelector(".manta-routines-findings [role=button]"));
    expect(setView).toHaveBeenCalledWith({ page: "routine", id: "a1b2c3d4", runId: "run_dg_23" });
  });

  it("Answer goes straight to the transcript", async () => {
    const setView = await mountRoot({ page: "list" });
    await click(h!, buttonByText(h!, "Answer"));
    expect(setView).toHaveBeenCalledWith({ page: "run", runId: "run_tr_9" });
  });

  it("a run known only by its id (a notification) resolves to its routine page with the run selected", async () => {
    const setView = await mountRoot({ page: "open-run", runId: "run_dg_23" });
    expect(setView).toHaveBeenCalledWith({ page: "routine", id: "a1b2c3d4", runId: "run_dg_23" });
  });

  it("a run that can't be opened says so and falls back to the list", async () => {
    const setView = await mountRoot({ page: "open-run", runId: "gone" }, { routinesRunGet: () => Promise.reject(new Error("No run with that id")) });
    expect(setView).toHaveBeenCalledWith({ page: "list" });
    expect(toasts().join(" ")).toContain("Couldn't open the run — No run with that id");
  });

  it("a run's × (and its routine-name crumb) return to the routine page with that run selected", async () => {
    const setView = await mountRoot({ page: "run", runId: "run_da_31" });
    // A run still waiting in line has no transcript yet: its header is the placeholder's.
    await click(h!, h!.container.querySelector('[aria-label="Close run"]'));
    expect(setView).toHaveBeenLastCalledWith({ page: "routine", id: "e5f6a7b8", runId: "run_da_31" });
    await click(h!, buttonByText(h!, "Routines"));
    expect(setView).toHaveBeenLastCalledWith({ page: "list" });
  });
});
