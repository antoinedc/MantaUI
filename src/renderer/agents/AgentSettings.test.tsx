// @vitest-environment jsdom
//
// The profile's Settings tab (profile v5, spec §5): each editable field saves when the user leaves it, through `agents:settings-set`,
// and says what happened right under the field — saved (with Undo), waiting, an error (the user's text kept, Try again) or nothing
// when nothing changed. The @handle, the refresh day and the team-wide learning setting are read-only; Manta and the Architect keep
// their wording "via Manta".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { AgentChange, AgentInfo, AgentProfile } from "../../shared/types";
import { installMockApi, mount, resetStore, type Harness, type MockApi } from "../testHarness";
import { AgentSettings } from "./AgentSettings";
import { buttonIn, changeRecord, clickEl } from "./agentsTestFixtures";

const info = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  slug: "dev",
  name: "Dev",
  description: "Writes code.",
  isolation: "worktree",
  model: null,
  color: null,
  builtIn: true,
  role: "specialist",
  useWhen: "Code changes.",
  notFor: null,
  notice: null,
  ...over,
});
const profile = (over: Partial<AgentProfile> = {}): AgentProfile =>
  ({ info: info(), seats: [], lastChangedAt: null, builtBy: "built-in", refresh: { enabled: true, routineId: "rt1", day: 12 }, research: [], ...over }) as AgentProfile;

const saved = (over: Partial<AgentChange> = {}): AgentChange => changeRecord({ id: "ach_1", slug: "dev", origin: { kind: "settings", field: "name" }, decidedBy: "click", summary: "Name: Dev → Developer.", ...over });

describe("AgentSettings", () => {
  let h: Harness | null = null;
  let api: MockApi;
  const onChanged = vi.fn();
  beforeEach(() => {
    resetStore();
    onChanged.mockClear();
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  async function open(p: AgentProfile = profile(), overrides: Record<string, unknown> = {}) {
    ({ api } = installMockApi({
      agentsApprovedModels: () => Promise.resolve(["anthropic/claude-sonnet-5-5", "openai/gpt-6-sol"]),
      agentsAutonomyGet: () => Promise.resolve({ mode: "balanced", overrides: {}, effective: { learn_preference: "tell" } }),
      ...overrides,
    }));
    h = mount(<AgentSettings profile={p} onChanged={onChanged} />);
    await h.flush();
    await h.flush();
  }
  const q = (sel: string) => h!.container.querySelector<HTMLElement>(sel);
  const field = (id: string) => q(`[data-testid="settings-field-${id}"]`)!;
  const status = (id: string) => field(id).querySelector('[role="status"]')!;
  const input = (id: string) => field(id).querySelector<HTMLInputElement | HTMLTextAreaElement>("input:not([type=radio]), textarea")!;
  async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    await act(async () => {
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function blur(el: HTMLElement) {
    await act(async () => {
      el.blur();
      el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await h!.flush();
  }

  it("shows each field with its label, the saved value and the box's limits", async () => {
    await open();
    expect(h!.container.textContent).toContain("Each change saves when you leave the field, shows up in History, and can be undone.");
    expect(input("name").value).toBe("Dev");
    expect(input("name").maxLength).toBe(40);
    expect(input("description").value).toBe("Writes code.");
    expect(input("description").maxLength).toBe(200);
    expect(input("useWhen").value).toBe("Code changes.");
    expect(input("notFor").value).toBe("");
    for (const id of ["name", "description", "useWhen", "notFor"]) {
      const el = input(id);
      expect(h!.container.querySelector(`label[for="${el.id}"]`)).toBeTruthy();
    }
    expect(q('select[aria-label], select')).toBeTruthy();
    expect([...field("isolation").querySelectorAll<HTMLInputElement>("input[type=radio]")].map((r) => [r.value, r.checked])).toEqual([["worktree", true], ["none", false]]);
  });

  it("the @handle is read-only, with the reason", async () => {
    await open();
    const handle = field("handle");
    expect(handle.textContent).toContain("@dev");
    expect(handle.querySelector("input, textarea, select")).toBeNull();
    expect(handle.textContent).toMatch(/Renaming it isn't available yet/);
  });

  it("leaving a changed field saves it through the new channel and says 'Saved · added to History' with Undo", async () => {
    let finish!: (r: unknown) => void;
    await open(profile(), { agentsSettingsSet: () => new Promise((r) => (finish = r)) });
    await type(input("name"), "  Developer ");
    expect(api.calls.agentsSettingsSet).toBeUndefined();
    await blur(input("name"));
    expect(api.calls.agentsSettingsSet).toEqual([[{ slug: "dev", field: "name", value: "Developer" }]]);
    expect(status("name").textContent).toContain("Saving…");
    await act(async () => finish({ outcome: "saved", change: saved() }));
    await h!.flush();
    expect(status("name").textContent).toContain("Saved · added to History");
    expect(buttonIn(status("name"), "Undo")).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
    expect(status("name").getAttribute("aria-live")).toBe("polite");
  });

  it("nothing is sent and nothing is said when the value didn't change", async () => {
    await open(profile(), { agentsSettingsSet: () => Promise.reject(new Error("must not be called")) });
    await type(input("name"), "Dev");
    await blur(input("name"));
    expect(api.calls.agentsSettingsSet).toBeUndefined();
    expect(status("name").textContent).toBe("");
  });

  it("an empty optional line goes as null (cleared)", async () => {
    await open(profile(), { agentsSettingsSet: () => Promise.resolve({ outcome: "saved", change: saved({ origin: { kind: "settings", field: "useWhen" } }) }) });
    await type(input("useWhen"), "   ");
    await blur(input("useWhen"));
    expect(api.calls.agentsSettingsSet).toEqual([[{ slug: "dev", field: "useWhen", value: null }]]);
  });

  it("a refusal keeps the user's text and offers Try again, which sends it again", async () => {
    let n = 0;
    await open(profile(), {
      agentsSettingsSet: () => (++n === 1 ? Promise.reject(new Error("The name can be at most 40 characters")) : Promise.resolve({ outcome: "saved", change: saved() })),
    });
    await type(input("name"), "A very long name indeed");
    await blur(input("name"));
    expect(status("name").textContent).toContain("The name can be at most 40 characters");
    expect(input("name").value).toBe("A very long name indeed");
    await clickEl(h!, buttonIn(status("name"), "Try again"));
    expect(api.calls.agentsSettingsSet).toHaveLength(2);
    expect(api.calls.agentsSettingsSet![1]).toEqual([{ slug: "dev", field: "name", value: "A very long name indeed" }]);
    expect(status("name").textContent).toContain("Saved · added to History");
  });

  it("Undo goes through the existing undo channel, says 'Undone', and the page is told", async () => {
    await open(profile(), {
      agentsSettingsSet: () => Promise.resolve({ outcome: "saved", change: saved() }),
      agentsChangeUndo: (id: string) => Promise.resolve({ ...saved(), id, state: "undone" }),
    });
    await type(input("name"), "Developer");
    await blur(input("name"));
    onChanged.mockClear();
    await clickEl(h!, buttonIn(status("name"), "Undo"));
    expect(api.calls.agentsChangeUndo).toEqual([["ach_1"]]);
    expect(status("name").textContent).toContain("Undone · back to the previous value");
    expect(onChanged).toHaveBeenCalled();
  });

  it("a refused Undo says why and can be tried again", async () => {
    await open(profile(), {
      agentsSettingsSet: () => Promise.resolve({ outcome: "saved", change: saved() }),
      agentsChangeUndo: () => Promise.reject(new Error("Dev was edited since; undo it by hand")),
    });
    await type(input("name"), "Developer");
    await blur(input("name"));
    await clickEl(h!, buttonIn(status("name"), "Undo"));
    expect(status("name").textContent).toContain("Dev was edited since; undo it by hand");
    expect(buttonIn(status("name"), "Try again")).toBeTruthy();
  });

  it("the Model select offers Auto and the approved models and saves as soon as it changes (Auto goes as null)", async () => {
    await open(profile(), { agentsSettingsSet: () => Promise.resolve({ outcome: "saved", change: saved({ origin: { kind: "settings", field: "model" } }) }) });
    const select = field("model").querySelector("select")!;
    expect([...select.options].map((o) => o.value)).toEqual(["", "anthropic/claude-sonnet-5-5", "openai/gpt-6-sol"]);
    expect([...select.options][0].textContent).toBe("Auto");
    await act(async () => {
      select.value = "openai/gpt-6-sol";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await h!.flush();
    expect(api.calls.agentsSettingsSet).toEqual([[{ slug: "dev", field: "model", value: "openai/gpt-6-sol" }]]);
    h!.unmount();
    await open(profile({ info: info({ model: "openai/gpt-6-sol" }) }), { agentsSettingsSet: () => Promise.resolve({ outcome: "saved", change: saved() }) });
    const sel2 = field("model").querySelector("select")!;
    expect(sel2.value).toBe("openai/gpt-6-sol");
    await act(async () => {
      sel2.value = "";
      sel2.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await h!.flush();
    expect(api.calls.agentsSettingsSet).toEqual([[{ slug: "dev", field: "model", value: null }]]);
  });

  it("Works: lowering to read-only saves; raising it says it waits for the user's click in Needs you", async () => {
    await open(profile(), { agentsSettingsSet: () => Promise.resolve({ outcome: "saved", change: saved({ origin: { kind: "settings", field: "isolation" } }) }) });
    const radios = [...field("isolation").querySelectorAll<HTMLInputElement>("input[type=radio]")];
    await act(async () => radios[1].click());
    await h!.flush();
    expect(api.calls.agentsSettingsSet).toEqual([[{ slug: "dev", field: "isolation", value: "none" }]]);
    h!.unmount();
    await open(profile({ info: info({ isolation: "none" }) }), { agentsSettingsSet: () => Promise.resolve({ outcome: "waiting", change: saved({ state: "pending", needsClick: true, reason: "isolation" }) }) });
    const again = [...field("isolation").querySelectorAll<HTMLInputElement>("input[type=radio]")];
    await act(async () => again[0].click());
    await h!.flush();
    expect(status("isolation").textContent).toContain("Waiting for your OK in Needs you");
    expect(buttonIn(status("isolation"), "Undo")).toBeUndefined();
  });

  it("Refresh is on or off through the existing channel; the day it runs is read-only", async () => {
    await open(profile(), { agentsRefreshSet: () => Promise.resolve({ enabled: false, routineId: "rt1" }) });
    const refresh = q('[data-testid="settings-refresh"]')!;
    expect(refresh.textContent).toContain("Runs monthly, on the 12th.");
    expect(refresh.querySelector("select")).toBeNull();
    await clickEl(h!, buttonIn(refresh, "Off"));
    expect(api.calls.agentsRefreshSet).toEqual([[{ slug: "dev", enabled: false }]]);
  });

  it("Learning shows the team-wide setting, read-only, with a link that opens Settings", async () => {
    await open();
    const learning = q('[data-testid="settings-learning"]')!;
    expect(learning.textContent).toContain("Team setting: learns from your corrections and tells you");
    expect(learning.querySelector("input, select, textarea")).toBeNull();
    const opened: Array<{ section?: string }> = [];
    const on = (e: Event) => opened.push((e as CustomEvent).detail);
    window.addEventListener("manta-open-settings", on);
    await clickEl(h!, buttonIn(learning, "Change in Settings"));
    window.removeEventListener("manta-open-settings", on);
    expect(opened).toEqual([{ section: "sessions" }]);
  });

  it("the Architect's wording is read-only with the note; its model is still the user's to set; no Refresh", async () => {
    await open(profile({ info: info({ slug: "architect", name: "Architect", role: "architect" }), refresh: { enabled: false, routineId: null, day: null } }), {
      agentsSettingsSet: () => Promise.resolve({ outcome: "saved", change: saved({ slug: "architect" }) }),
    });
    expect(h!.container.textContent).toContain("Architect is built into Manta");
    expect(h!.container.textContent).toContain("always wait for your click");
    for (const id of ["name", "description", "useWhen", "notFor"]) expect(field(id).querySelector("input, textarea")).toBeNull();
    expect(field("isolation").querySelector("input")).toBeNull();
    expect(field("model").querySelector("select")).toBeTruthy();
    expect(q('[data-testid="settings-refresh"]')).toBeNull();
    const select = field("model").querySelector("select")!;
    await act(async () => {
      select.value = "openai/gpt-6-sol";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await h!.flush();
    expect(api.calls.agentsSettingsSet).toEqual([[{ slug: "architect", field: "model", value: "openai/gpt-6-sol" }]]);
  });

  it("Manta's model is read-only too", async () => {
    await open(profile({ info: info({ slug: "manta", name: "Manta", role: "lead" }) }));
    expect(h!.container.textContent).toContain("Manta is built into Manta");
    expect(field("model").querySelector("select")).toBeNull();
  });

  it("a model list the box couldn't give leaves Auto and the current model, with nothing broken", async () => {
    await open(profile({ info: info({ model: "x/gone" }) }), { agentsApprovedModels: () => Promise.reject(new Error("unknown rpc channel: agents:approved-models")) });
    const select = field("model").querySelector("select")!;
    expect([...select.options].map((o) => o.value)).toEqual(["", "x/gone"]);
  });
});
