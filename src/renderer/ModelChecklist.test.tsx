// @vitest-environment jsdom
//
// ModelChecklist (BET-1312) — the one shared model checklist, gated on ONE
// prop (`onBulkChange`). `onBulkChange` present → the filter box AND the
// All/None row render; absent → neither. All/None act only on the VISIBLE
// (filtered) ids and are the caller's batch hook.
//
// Rendered through the real primitives (Field / Button / Checkbox / ListRow), so
// the ListRow double-toggle guard is exercised exactly as a user operates it:
// clicking the visible box fires the checkbox once; clicking the row body fires
// the row toggle once.

import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { mount, type Harness } from "./testHarness";
import { ModelChecklist } from "./ModelChecklist";

function buttonByText(h: Harness, text: string): HTMLButtonElement | null {
  for (const b of Array.from(h.container.querySelectorAll("button"))) {
    if ((b.textContent ?? "").trim() === text) return b;
  }
  return null;
}

function checkboxByLabel(h: Harness, label: string): HTMLInputElement | null {
  return (
    (Array.from(h.container.querySelectorAll('input[type="checkbox"]')).find(
      (i) => i.getAttribute("aria-label") === label,
    ) as HTMLInputElement | null) ?? null
  );
}

function filterInput(h: Harness): HTMLInputElement | null {
  return h.container.querySelector('input[aria-label="Filter models"]') as HTMLInputElement | null;
}

function setFilter(h: Harness, value: string): void {
  const input = filterInput(h);
  expect(input).toBeTruthy();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const MODELS: { id: string }[] = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("ModelChecklist", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("without onBulkChange renders neither the filter input nor All/None — but keeps the counter", () => {
    h = mount(
      <ModelChecklist models={MODELS} checked={new Set(["a"])} onToggle={() => {}} disabled={false} />,
    );
    expect(filterInput(h)).toBeNull();
    expect(buttonByText(h, "All")).toBeNull();
    expect(buttonByText(h, "None")).toBeNull();
    expect(h.text()).toContain("1 of 3 selected");
  });

  it("with onBulkChange renders both the filter input and All/None", () => {
    h = mount(
      <ModelChecklist
        models={MODELS}
        checked={new Set()}
        onToggle={() => {}}
        onBulkChange={() => {}}
        disabled={false}
      />,
    );
    expect(filterInput(h)).toBeTruthy();
    expect(buttonByText(h, "All")).toBeTruthy();
    expect(buttonByText(h, "None")).toBeTruthy();
  });

  it("filters by case-insensitive substring and reduces the visible rows", () => {
    h = mount(
      <ModelChecklist
        models={[{ id: "AlphaModel" }, { id: "betaMODEL" }, { id: "Gamma" }]}
        checked={new Set()}
        onToggle={() => {}}
        onBulkChange={() => {}}
        disabled={false}
      />,
    );
    setFilter(h, "MODEL");
    expect(h.text()).toContain("0 of 3 selected · 2 shown");
    const names = Array.from(h.container.querySelectorAll("span.text-text")).map(
      (n) => n.textContent,
    );
    expect(names).toContain("AlphaModel");
    expect(names).toContain("betaMODEL");
    expect(names).not.toContain("Gamma");
  });

  it("All / None call onBulkChange with ONLY the filtered ids and the right next flag", () => {
    const bulk = vi.fn();
    h = mount(
      <ModelChecklist
        models={MODELS}
        checked={new Set()}
        onToggle={() => {}}
        onBulkChange={bulk}
        disabled={false}
      />,
    );
    setFilter(h, "b");
    act(() => {
      buttonByText(h!, "All 1")!.click();
    });
    expect(bulk).toHaveBeenCalledTimes(1);
    expect(bulk).toHaveBeenCalledWith(["b"], true);
    bulk.mockClear();

    // The parent applies the All → now "b" is checked, so None activates.
    h.rerender(
      <ModelChecklist
        models={MODELS}
        checked={new Set(["b"])}
        onToggle={() => {}}
        onBulkChange={bulk}
        disabled={false}
      />,
    );
    act(() => {
      buttonByText(h!, "None")!.click();
    });
    expect(bulk).toHaveBeenCalledTimes(1);
    expect(bulk).toHaveBeenCalledWith(["b"], false);
  });

  it("All is disabled when every visible row is checked; None when none is", () => {
    h = mount(
      <ModelChecklist
        models={MODELS}
        checked={new Set(["a", "b", "c"])}
        onToggle={() => {}}
        onBulkChange={() => {}}
        disabled={false}
      />,
    );
    expect(buttonByText(h, "All")!.disabled).toBe(true);
    expect(buttonByText(h, "None")!.disabled).toBe(false);
    h.unmount();

    h = mount(
      <ModelChecklist
        models={MODELS}
        checked={new Set()}
        onToggle={() => {}}
        onBulkChange={() => {}}
        disabled={false}
      />,
    );
    expect(buttonByText(h, "All")!.disabled).toBe(false);
    expect(buttonByText(h, "None")!.disabled).toBe(true);
  });

  it("a filter matching nothing shows the empty state and disables both buttons; clearing restores rows with selection intact", () => {
    h = mount(
      <ModelChecklist
        models={MODELS}
        checked={new Set(["a"])}
        onToggle={() => {}}
        onBulkChange={() => {}}
        disabled={false}
      />,
    );
    setFilter(h, "zzz");
    expect(h.text()).toContain("No model matches");
    // Filter active → the All label carries the visible count ("All 0").
    expect(buttonByText(h, "All 0")!.disabled).toBe(true);
    expect(buttonByText(h, "None")!.disabled).toBe(true);
    // Rows are hidden but selection is untouched by filtering.
    expect(checkboxByLabel(h, "a")).toBeNull();

    setFilter(h, "");
    expect(h.text()).not.toContain("No model matches");
    expect(checkboxByLabel(h, "a")!.checked).toBe(true);
    expect(checkboxByLabel(h, "b")).toBeTruthy();
  });

  it("clicking the row body toggles exactly once (ListRow double-toggle guard)", () => {
    const toggle = vi.fn();
    h = mount(
      <ModelChecklist
        models={[{ id: "a" }]}
        checked={new Set()}
        onToggle={toggle}
        onBulkChange={() => {}}
        disabled={false}
      />,
    );
    const nameEl = h.container.querySelector("span.text-text") as HTMLElement;
    expect(nameEl).toBeTruthy();
    act(() => {
      nameEl.click();
    });
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveBeenCalledWith("a");
  });

  it("respects disabled on the rows and the batch buttons", () => {
    h = mount(
      <ModelChecklist
        models={MODELS}
        checked={new Set(["a"])}
        onToggle={() => {}}
        onBulkChange={() => {}}
        disabled={true}
      />,
    );
    expect(checkboxByLabel(h, "a")!.disabled).toBe(true);
    expect(buttonByText(h, "All")!.disabled).toBe(true);
    expect(buttonByText(h, "None")!.disabled).toBe(true);
  });
});
