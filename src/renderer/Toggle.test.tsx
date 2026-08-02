// @vitest-environment jsdom
//
// Component tests for the Toggle chrome primitive (BET-614, stage 3 of M527).
//
// As with the other primitives, the "tokens" are class names that map through
// tailwind.config.js to the design tokens (w-9 → 36px, h-5 → 20px, w-3.5 →
// 14px, left-[18px] → the 18px on-knob offset, bg-accent-solid →
// --accent-solid). jsdom loads no stylesheet, so the contract is asserted on
// the exact class strings — a retune of Toggle's chrome fails here
// immediately. Both boolean setting adopters (chatAutoAllow + allowAgentPush)
// live in Settings.tsx; the on/off class switching below is the primitive's.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { Toggle } from "./Toggle";

const TRACK =
  "relative shrink-0 w-9 h-5 rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
const TRACK_OFF = "bg-fill-active border-border";
const TRACK_ON = "bg-accent-solid border-accent-solid";
const KNOB = "absolute top-[2px] w-3.5 h-3.5 rounded-full transition-all";
const KNOB_OFF = "left-[2px] bg-text-faint";
const KNOB_ON = "left-[18px] bg-on-accent";

describe("Toggle", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders a button with role=switch", () => {
    h = mount(<Toggle checked={false} onChange={() => {}} ariaLabel="Auto-allow" />);
    const el = h.container.querySelector("button") as HTMLButtonElement;
    expect(el).toBeTruthy();
    expect(el.getAttribute("role")).toBe("switch");
    expect(el.getAttribute("type")).toBe("button");
  });

  it("mirrors aria-checked from checked", () => {
    h = mount(<Toggle checked={false} onChange={() => {}} ariaLabel="Auto-allow" />);
    expect((h.container.querySelector("button") as HTMLButtonElement).getAttribute("aria-checked")).toBe("false");
    h.rerender(<Toggle checked={true} onChange={() => {}} ariaLabel="Auto-allow" />);
    expect((h.container.querySelector("button") as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
  });

  it("switches on/off chrome classes with the checked state", () => {
    h = mount(<Toggle checked={false} onChange={() => {}} ariaLabel="Auto-allow" />);
    const btn = h.container.querySelector("button") as HTMLButtonElement;
    const knob = h.container.querySelector("span") as HTMLElement;
    expect(btn.className).toBe(`${TRACK} ${TRACK_OFF}`);
    expect(knob.className).toBe(`${KNOB} ${KNOB_OFF}`);
    h.rerender(<Toggle checked={true} onChange={() => {}} ariaLabel="Auto-allow" />);
    expect(btn.className).toBe(`${TRACK} ${TRACK_ON}`);
    expect((h.container.querySelector("span") as HTMLElement).className).toBe(`${KNOB} ${KNOB_ON}`);
  });

  it("fires onChange with the new state on click", () => {
    const seen: boolean[] = [];
    h = mount(<Toggle checked={false} onChange={(v) => seen.push(v)} ariaLabel="Auto-allow" />);
    (h.container.querySelector("button") as HTMLButtonElement).click();
    expect(seen).toEqual([true]);
  });

  it("passes disabled through to the native button", () => {
    h = mount(<Toggle checked={false} onChange={() => {}} ariaLabel="Auto-allow" disabled />);
    expect((h.container.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("wires id and aria-label through", () => {
    h = mount(<Toggle checked={false} onChange={() => {}} ariaLabel="Save files" id="setting-allowAgentPush" />);
    const el = h.container.querySelector("button") as HTMLButtonElement;
    expect(el.getAttribute("id")).toBe("setting-allowAgentPush");
    expect(el.getAttribute("aria-label")).toBe("Save files");
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // @ts-expect-error — Toggle must NOT accept className (M527 decision 3)
    void <Toggle checked={false} onChange={() => {}} ariaLabel="x" className="bg-red-500" />;
    expect(true).toBe(true);
  });
});
