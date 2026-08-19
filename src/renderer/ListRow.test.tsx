// @vitest-environment jsdom
//
// Regression tests for the ListRow row-click guard (BET-1199).
//
// The guard: a row that contains its own controls must not also handle those
// controls' clicks. A <label>-wrapped checkbox re-dispatches a click on its
// hidden <input>, so one user click on the visible box yields TWO click events
// at the row; an unguarded row `onClick` would toggle twice — selecting then
// instantly deselecting. The guard ignores clicks whose target is (or is
// inside) an interactive control and lets the control act.
//
// CRITICAL — assert invocation COUNTS, not final selection. jsdom batches
// React state updates inside act(), so both row invocations read the stale
// value and the final selection ends up correct under test even while it is
// broken in a real browser. The existing tests clicked the hidden <input>
// directly — a target no user can reach — which is exactly how this defect
// reached users.

import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { mount, type Harness } from "./testHarness";
import { ListRow } from "./ListRow";
import { Checkbox } from "./Checkbox";

describe("ListRow", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("clicking the visible box ignores the row onClick and fires the checkbox onChange exactly once", () => {
    const rowClick = vi.fn();
    const checkChange = vi.fn();
    h = mount(
      <ListRow
        onClick={rowClick}
        leading={<Checkbox checked={false} onChange={checkChange} ariaLabel="toggle" />}
        name="Alpha"
      />,
    );
    const box = h.container.querySelector("label > span") as HTMLElement;
    expect(box).toBeTruthy();
    act(() => {
      box.click();
    });
    // The row must NOT act on the control's click (the control owns it).
    expect(rowClick).toHaveBeenCalledTimes(0);
    expect(checkChange).toHaveBeenCalledTimes(1);
  });

  it("clicking the row's name invokes the row onClick exactly once", () => {
    const rowClick = vi.fn();
    h = mount(
      <ListRow
        onClick={rowClick}
        leading={<Checkbox checked={false} onChange={() => {}} ariaLabel="toggle" />}
        name="Alpha"
      />,
    );
    const nameEl = h.container.querySelector("span.text-text") as HTMLElement;
    expect(nameEl).toBeTruthy();
    act(() => {
      nameEl.click();
    });
    expect(rowClick).toHaveBeenCalledTimes(1);
  });

  it("clicking a button in the trailing slot ignores the row onClick", () => {
    const rowClick = vi.fn();
    const btnClick = vi.fn();
    h = mount(
      <ListRow
        onClick={rowClick}
        name="Alpha"
        trailing={<button onClick={btnClick}>Disconnect</button>}
      />,
    );
    const btn = h.container.querySelector("button") as HTMLElement;
    expect(btn).toBeTruthy();
    act(() => {
      btn.click();
    });
    expect(rowClick).toHaveBeenCalledTimes(0);
    expect(btnClick).toHaveBeenCalledTimes(1);
  });

  it("a row with no onClick renders with no role and no tabIndex", () => {
    h = mount(<ListRow name="Alpha" />);
    const row = h.container.firstElementChild as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.getAttribute("role")).toBeNull();
    expect(row.getAttribute("tabIndex")).toBeNull();
  });
});
