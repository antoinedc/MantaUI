// @vitest-environment jsdom
//
// Settings → Agents autonomy (Agents Phase 3 spec §6): the mode switch fills every row, a changed row says "custom", reset
// clears the rows, every save sends the FULL block and shows what the box returned, a failed save restores the last saved
// state, and the card exists only when the box has the channels.

import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { ACTION_KINDS, MODES, MODE_TITLES } from "../../shared/autonomyShared.mjs";
import type { AgentAutonomy, AutonomyKind, AutonomyLevel, AutonomyMode, AutonomySettings } from "../../shared/types";
import { buttonByText, mountWithMockApi, type Harness, type MockApi } from "../testHarness";
import { AutonomyCard, blockForRow, effectiveOf, isAutonomySettings, levelsFor } from "./AutonomyCard";

const settings = (block: AgentAutonomy): AutonomySettings => ({ ...block, effective: effectiveOf(block) });
const BALANCED = settings({ mode: "balanced", overrides: {} });

describe("autonomy helpers", () => {
  it("blockForRow adds an override, and removes it again when the mode's own answer is picked", () => {
    const a = blockForRow({ mode: "balanced", overrides: {} }, "deploy", "never");
    expect(a).toEqual({ mode: "balanced", overrides: { deploy: "never" } });
    expect(blockForRow(a, "deploy", "ask")).toEqual({ mode: "balanced", overrides: {} });
    expect(blockForRow(a, "merge", "tell")).toEqual({ mode: "balanced", overrides: { deploy: "never", merge: "tell" } });
  });
  it("Change code offers only Auto and Never; every other kind offers all four", () => {
    expect(levelsFor("edit_code")).toEqual(["auto", "never"]);
    expect(levelsFor("deploy")).toEqual(["auto", "tell", "ask", "never"]);
  });
  it("effectiveOf is the mode's row with the overrides on top", () => {
    expect(effectiveOf({ mode: "autonomous", overrides: { deploy: "ask" } }).deploy).toBe("ask");
    expect(effectiveOf({ mode: "autonomous", overrides: {} })).toEqual(MODES.autonomous);
  });
  it("isAutonomySettings rejects null and malformed answers", () => {
    expect(isAutonomySettings(null)).toBe(false);
    expect(isAutonomySettings({ mode: "wild", overrides: {}, effective: {} })).toBe(false);
    expect(isAutonomySettings(BALANCED)).toBe(true);
  });
});

describe("AutonomyCard", () => {
  let h: Harness | null = null;
  let api: MockApi;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  async function open(overrides: Record<string, unknown> = {}) {
    ({ h, api } = await mountWithMockApi(<AutonomyCard />, {
      agentsAutonomyGet: () => Promise.resolve(BALANCED),
      agentsAutonomySet: (b: AgentAutonomy) => Promise.resolve(settings(b)),
      ...overrides,
    }));
  }
  const q = <T extends HTMLElement>(sel: string) => h!.container.querySelector(sel) as T | null;
  const select = (kind: AutonomyKind) => q<HTMLSelectElement>(`select[name="${kind}"]`)!;
  const modeButton = (mode: string) =>
    Array.from(q('[role="group"][aria-label="Mode"]')!.querySelectorAll("button")).find((b) => b.textContent === MODE_TITLES[mode as AutonomyMode])!;
  const modePressed = (mode: string) => modeButton(mode).getAttribute("aria-pressed") === "true";
  const customKinds = () => Array.from(h!.container.querySelectorAll("tr[data-custom]")).map((r) => r.getAttribute("data-kind"));
  const lastSet = (): AgentAutonomy => {
    const calls = api.calls.agentsAutonomySet;
    return calls[calls.length - 1][0] as AgentAutonomy;
  };
  async function choose(kind: AutonomyKind, level: AutonomyLevel) {
    await act(async () => {
      const el = select(kind);
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, level);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await h!.flush();
  }
  async function pickMode(mode: string) {
    await act(async () => {
      modeButton(mode).click();
    });
    await h!.flush();
  }

  it("renders every kind with the mode's answer, and no custom tag", async () => {
    await open();
    expect(h!.container.querySelectorAll("tbody tr")).toHaveLength(ACTION_KINDS.length);
    for (const k of ACTION_KINDS) expect(select(k).value).toBe(MODES.balanced[k]);
    expect(modePressed("balanced")).toBe(true);
    expect(customKinds()).toEqual([]);
    expect(buttonByText(h!, "Reset rows to mode")).toBeNull();
    expect(Array.from(select("edit_code").options).map((o) => o.value)).toEqual(["auto", "never"]);
    expect(Array.from(select("deploy").options).map((o) => o.text)).toEqual(["Auto", "Tell me", "Ask", "Never"]);
    expect(h!.text()).toContain("Changes apply to new chats");
    expect(h!.text()).toContain(
      "What your agents may do on their own. Manta and the agents it hands work to are instructed to follow this: each action is " +
        "explained to them, they are told to stop when unsure, and every task is asked to report what it did or was blocked from. " +
        "Blocking only catches obvious commands, such as gh pr merge, fly deploy or the deploy scripts listed on a project's " +
        '"Actions in this project" page; an agent that goes another way can get around it. Changes apply to new chats.',
    );
    expect(Array.from(h!.container.querySelectorAll("p code")).map((c) => c.textContent)).toEqual(["gh pr merge", "fly deploy"]);
  });

  it("switching the mode saves {mode, overrides:{}} and the rows follow the box's answer", async () => {
    await open({ agentsAutonomyGet: () => Promise.resolve(settings({ mode: "balanced", overrides: { deploy: "never" } })) });
    expect(customKinds()).toEqual(["deploy"]);
    await pickMode("autonomous");
    expect(lastSet()).toEqual({ mode: "autonomous", overrides: {} });
    expect(modePressed("autonomous")).toBe(true);
    for (const k of ACTION_KINDS) expect(select(k).value).toBe(MODES.autonomous[k]);
    expect(customKinds()).toEqual([]);
    expect(h!.text()).toContain("Saved. Changes apply to new chats.");
  });

  it("changing a row sends the full block and marks the row custom; picking the mode's answer clears it", async () => {
    await open();
    await choose("deploy", "never");
    expect(lastSet()).toEqual({ mode: "balanced", overrides: { deploy: "never" } });
    expect(select("deploy").value).toBe("never");
    expect(customKinds()).toEqual(["deploy"]);
    expect(h!.text()).toContain("custom");
    await choose("merge", "tell");
    expect(lastSet()).toEqual({ mode: "balanced", overrides: { deploy: "never", merge: "tell" } });
    await choose("deploy", "ask");
    expect(lastSet()).toEqual({ mode: "balanced", overrides: { merge: "tell" } });
    expect(customKinds()).toEqual(["merge"]);
  });

  it("Reset rows to mode saves the mode with no overrides", async () => {
    await open({ agentsAutonomyGet: () => Promise.resolve(settings({ mode: "cautious", overrides: { spend: "never", deploy: "auto" } })) });
    expect(customKinds().sort()).toEqual(["deploy", "spend"]);
    await act(async () => {
      buttonByText(h!, "Reset rows to mode")!.click();
    });
    await h!.flush();
    expect(lastSet()).toEqual({ mode: "cautious", overrides: {} });
    expect(customKinds()).toEqual([]);
    expect(buttonByText(h!, "Reset rows to mode")).toBeNull();
  });

  it("a failed save says why and puts the last saved state back", async () => {
    await open({ agentsAutonomySet: () => Promise.reject(new Error("Couldn't write the config.")) });
    await choose("deploy", "never");
    const err = q('[data-testid="autonomy-error"]')!;
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.textContent).toContain("Couldn't write the config.");
    expect(select("deploy").value).toBe("ask");
    expect(customKinds()).toEqual([]);
    await pickMode("autonomous");
    expect(modePressed("balanced")).toBe(true);
    expect(modePressed("autonomous")).toBe(false);
    expect(select("merge").value).toBe("ask");
  });

  it("an older box (unknown rpc channel) hides the card entirely", async () => {
    await open({ agentsAutonomyGet: () => Promise.reject(new Error("unknown rpc channel: agents:autonomy-get")) });
    expect(q('[data-testid="autonomy-card"]')).toBeNull();
    expect(h!.container.textContent).toBe("");
  });

  it("a transport that answers nothing useful (the demo) hides the card too", async () => {
    await open({ agentsAutonomyGet: () => Promise.resolve(null) });
    expect(q('[data-testid="autonomy-card"]')).toBeNull();
  });

  it("any other load failure shows an inline error with Retry, and Retry loads the card", async () => {
    let n = 0;
    await open({
      agentsAutonomyGet: () => (n++ === 0 ? Promise.reject(new Error("box is busy")) : Promise.resolve(BALANCED)),
    });
    expect(q('[role="alert"]')!.textContent).toContain("box is busy");
    await act(async () => {
      buttonByText(h!, "Try again")!.click();
    });
    await h!.flush();
    expect(q('[data-testid="autonomy-table"]')).not.toBeNull();
    expect(q('[role="alert"]')).toBeNull();
  });
});
