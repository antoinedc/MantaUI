// @vitest-environment jsdom
//
// Component tests for the SettingsRow chrome primitive (BET-614, stage 5 of M527).
//
// jsdom loads no stylesheet, so the contract is asserted on the exact class
// strings — a retune of SettingsRow's chrome fails here immediately. Registered
// for the enforce net; no web adopter exists in the currently-named files
// (Settings.tsx's private SettingField is a `Field` input, not a `.setrow` row,
// and ProvidersCard.tsx's rows are endpoint list items — neither carries the
// row/name/help/control shape this primitive owns, reported in BET-619), so
// there is no call-site migration to assert.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { SettingsRow } from "./SettingsRow";

const ROW =
  "flex items-start gap-5 py-3 border-b border-border-subtle last:border-b-0";
const LAB = "flex-1 min-w-0";
const NAME = "block text-body font-medium text-text";
const HELP = "block text-[12.5px] leading-[1.5] text-text-faint mt-[3px] max-w-[62ch]";
const CTL = "shrink-0 flex items-center gap-2 pt-[2px]";

function rowEl(h: Harness): HTMLElement {
  const el = h.container.firstElementChild as HTMLElement;
  expect(el).toBeTruthy();
  return el;
}

describe("SettingsRow", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders the exact row + label + name + control chrome", () => {
    h = mount(<SettingsRow name="Name"><button /></SettingsRow>);
    expect(rowEl(h).className).toBe(ROW);
    const lab = rowEl(h).children[0] as HTMLElement;
    const ctl = rowEl(h).children[1] as HTMLElement;
    expect(lab.className).toBe(LAB);
    expect(lab.firstElementChild?.className).toBe(NAME);
    expect(ctl.className).toBe(CTL);
  });

  it("renders the name and the children control", () => {
    h = mount(
      <SettingsRow name="Prompt cache lifetime">
        <button data-testid="ctl">1 hour</button>
      </SettingsRow>,
    );
    expect(rowEl(h).textContent).toBe("Prompt cache lifetime1 hour");
    const nameEl = rowEl(h).querySelector("span[class*='text-body']") as HTMLElement;
    expect(nameEl.textContent).toBe("Prompt cache lifetime");
    expect(rowEl(h).querySelector('[data-testid="ctl"]')).toBeTruthy();
  });

  it("renders help text when provided", () => {
    h = mount(
      <SettingsRow name="Name" help="Must match what opencode sends.">
        <button />
      </SettingsRow>,
    );
    const helpEl = rowEl(h).querySelector("span[class*='text-[12.5px]']") as HTMLElement;
    expect(helpEl).toBeTruthy();
    expect(helpEl.className).toBe(HELP);
    expect(helpEl.textContent).toBe("Must match what opencode sends.");
  });

  it("omits the help block entirely when help is absent", () => {
    h = mount(<SettingsRow name="Name"><button /></SettingsRow>);
    expect(rowEl(h).querySelector("span[class*='text-[12.5px]']")).toBeNull();
  });

  it("carries the last-child border removal on the row chrome", () => {
    expect(ROW).toContain("last:border-b-0");
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // @ts-expect-error — SettingsRow must NOT accept className (M527 decision 3)
    void <SettingsRow name="x" className="bg-red-500">y</SettingsRow>;
    expect(true).toBe(true);
  });
});
