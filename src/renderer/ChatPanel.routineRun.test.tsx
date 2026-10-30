// @vitest-environment jsdom
//
// A routine run inside the real <ChatPanel> (spec §6.5): header crumb + Keep in
// sidebar, the run bar, the instruction block as the first user turn, the
// report card, and the composer hint — with no controls that act on a window a
// run does not have.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { ChatPanel } from "./ChatPanel";
import { createRoutinesStore, routineRunMessages, ROUTINES_T0 } from "./api/demoRoutines";
import { pinDemoClock } from "./clock";
import { installMockApi, mount, resetStore, type Harness } from "./testHarness";
import type { RoutineRunBinding } from "./routineRunContext";

const SID = "ses_run_digest_thu30";

describe("ChatPanel — routine run", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  async function open(messages = routineRunMessages(), over: Partial<RoutineRunBinding> = {}) {
    pinDemoClock(ROUTINES_T0);
    const store = createRoutinesStore();
    const { run, routine } = await store.runGet("run_dg_23");
    const binding: RoutineRunBinding = {
      run,
      routine,
      prevRunId: "run_dg_22",
      nextRunId: null,
      onNavigate: vi.fn(),
      onKeep: vi.fn(),
      onBack: vi.fn(),
      onOpenRoutine: vi.fn(),
      onFixIt: vi.fn(),
      ...over,
    };
    installMockApi({ opencodeMessages: () => Promise.resolve(messages) });
    resetStore({} as never);
    h = mount(<ChatPanel sessionId={SID} tmuxSession={null} windowIndex={null} cwd={routine.directory} isActive projectName="ronda" winName={routine.name} routineRun={binding} />);
    await h.flush();
    await h.flush();
    return binding;
  }
  const byText = (text: string) =>
    [...document.body.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text) as HTMLButtonElement | undefined;
  async function click(el: Element | undefined | null) {
    expect(el, "expected the control").toBeTruthy();
    await act(async () => {
      (el as HTMLElement).click();
    });
    await h!.flush();
  }

  it("draws the routine header, run bar, instructions and report", async () => {
    await open();
    const text = h!.text();
    expect(text).toContain("Routines");
    expect(text).toContain("Daily analytics digest");
    expect(text).toContain("Thu 30 Oct · 9:02");
    expect(text).toContain("read-only");
    expect(h!.container.querySelector(".manta-routines-runbar")?.textContent).toContain("Scheduled run");
    expect(h!.container.querySelector(".manta-routines-runbar")?.textContent).toContain("38.2k tokens");
    expect(text).toContain("Routine instructions");
    expect(text).toContain("$posthog-digest");
    expect(h!.container.querySelectorAll(".manta-routines-report").length).toBe(1);
    expect(text).toContain("Notified you at 9:04");
    expect(text).toContain("Replies stay with this run");
  });

  it("offers no controls for a tmux window, the toolbar or the artifacts panel", async () => {
    await open();
    expect(h!.container.querySelector('[aria-label="Session actions"]')).toBeNull();
    expect(h!.container.querySelector('[aria-label="Show artifacts"]')).toBeNull();
    expect(h!.container.querySelector('[aria-label="Hide artifacts"]')).toBeNull();
  });

  it("Keep in sidebar, the crumbs and the report's Fix it call the binding", async () => {
    const b = await open();
    await click(byText("Keep in sidebar"));
    expect(b.onKeep).toHaveBeenCalled();
    await click(byText("Routines"));
    expect(b.onBack).toHaveBeenCalled();
    await click(byText("Daily analytics digest"));
    expect(b.onOpenRoutine).toHaveBeenCalled();
    await click(byText("Fix it in a new session"));
    expect(b.onFixIt).toHaveBeenCalled();
  });

  it("previous / next move between runs; next is disabled on the latest run", async () => {
    const b = await open();
    expect(byText("Next ›")?.disabled).toBe(true);
    await click(byText("‹ Previous"));
    expect(b.onNavigate).toHaveBeenCalledWith("run_dg_22");
  });

  it("a run whose transcript has no routine_report call still ends with the report card", async () => {
    const withoutReport = routineRunMessages().map((m) => ({ ...m, parts: m.parts.filter((p) => (p as { tool?: string }).tool !== "routine_report") }));
    await open(withoutReport as never);
    expect(h!.container.querySelectorAll(".manta-routines-report").length).toBe(1);
  });
});
