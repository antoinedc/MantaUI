// @vitest-environment jsdom
//
// ModelMenu footer (BET-645) — the "Manage models…" row renders into the
// Dropdown footer slot and, when clicked, closes the menu and dispatches the
// generic `manta-open-settings` window bridge with the Models section id
// (consumed by App, which owns the Settings modal — this test pins the
// dispatch contract so a retune of the event name/section can't silently
// break the opener).

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { ModelMenu } from "./ModelMenu";
import type { OpencodeModel } from "../shared/types";

const GROUPS: Array<[string, OpencodeModel[]]> = [
  [
    "anthropic",
    [{ id: "claude-opus-4-7", providerID: "anthropic", name: "Claude Opus 4.7" }],
  ],
];

// anchorRef is required now that the menu is portalled to <body>. The anchor
// itself (the model button) isn't mounted by these unit tests; a null-current
// ref is enough for Popover to render the surface (positioning no-ops).
const anchorRef = () => ({ current: null }) as React.RefObject<HTMLButtonElement>;

// The menu surface is portalled to <body> by Popover (never a child of the
// harness container).
function surface(): HTMLElement {
  const el = document.body.querySelector(".manta-model-dropdown") as HTMLElement;
  expect(el, "model dropdown should be portalled onto <body>").toBeTruthy();
  return el;
}

function manageButton(): HTMLButtonElement | undefined {
  return [...surface().querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.trim().includes("Manage models…"),
  );
}

describe("ModelMenu footer — Manage models… (BET-645)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders a non-option 'Manage models…' action in the footer slot", () => {
    h = mount(
      <ModelMenu
        open
        anchorRef={anchorRef()}
        groups={GROUPS}
        modelOverride={null}
        defaultModel={{ providerID: "anthropic", modelID: "claude-opus-4-7" }}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    const btn = manageButton();
    expect(btn).toBeTruthy();
    // It is a plain footer action — NOT a MenuOption / menuitem (no tick slot,
    // not part of the option ring).
    expect(btn?.getAttribute("role")).not.toBe("option");
    expect(btn?.className).toContain("w-full");
    expect(btn?.className).toContain("text-text-faint");
    expect(btn?.className).toContain("hover:bg-fill-hover");
  });

  it("closes the menu and dispatches a manta-open-settings bridge for the models section", () => {
    let closed = 0;
    let section: string | undefined;
    let dispatchCount = 0;
    const handler = (e: Event) => {
      dispatchCount++;
      section = (e as CustomEvent<{ section?: string }>).detail?.section;
    };
    window.addEventListener("manta-open-settings", handler);
    try {
      h = mount(
        <ModelMenu
          open
          anchorRef={anchorRef()}
          groups={GROUPS}
          modelOverride={null}
          defaultModel={{ providerID: "anthropic", modelID: "claude-opus-4-7" }}
          onSelect={() => {}}
          onClose={() => {
            closed++;
          }}
        />,
      );
      const btn = manageButton();
      expect(btn).toBeTruthy();
      btn!.click();
      expect(closed).toBe(1);
      expect(dispatchCount).toBe(1);
      expect(section).toBe("models");
    } finally {
      window.removeEventListener("manta-open-settings", handler);
    }
  });
});
