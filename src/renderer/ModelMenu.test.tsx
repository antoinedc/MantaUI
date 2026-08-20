// @vitest-environment jsdom
//
// ModelMenu footer (BET-645) — the "Manage models…" row renders into the
// Dropdown footer slot and, when clicked, closes the menu and dispatches the
// generic `manta-open-settings` window bridge with the Models section id
// (consumed by App, which owns the Settings modal — this test pins the
// dispatch contract so a retune of the event name/section can't silently
// break the opener).

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { mount, type Harness } from "./testHarness";
import { ModelMenu } from "./ModelMenu";
import type { OpencodeModel } from "../shared/types";

const GROUPS: Array<[string, OpencodeModel[]]> = [
  [
    "anthropic",
    [{ id: "claude-opus-4-7", providerID: "anthropic", name: "Claude Opus 4.7", capabilities: { input: ["text"] } }],
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

describe("ModelMenu defaultRow — pinned top-row copy override (BET-948)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("omitted → today's exact 'Server default' label + sub line", () => {    h = mount(
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
    const text = surface().textContent ?? "";
    expect(text).toContain("Server default");
    expect(text).toContain("Claude Opus 4.7 · set in Settings");
  });

  it("overrides ONLY the pinned row's label/sub, leaving the body unchanged", () => {
    h = mount(
      <ModelMenu
        open
        anchorRef={anchorRef()}
        groups={GROUPS}
        modelOverride={null}
        defaultModel={{ providerID: "anthropic", modelID: "claude-opus-4-7" }}
        defaultRow={{ label: "Inherit build model", sub: "uses this session's model" }}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    const text = surface().textContent ?? "";
    expect(text).toContain("Inherit build model");
    expect(text).toContain("uses this session's model");
    // Today's "set in Settings" copy is gone from the pinned row.
    expect(text).not.toContain("set in Settings");
    // The body's model row is untouched.
    expect(text).toContain("Claude Opus 4.7");
  });
});

describe("ModelMenu deprecated disabled rows (BET-1139)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  const DEP_GROUPS: Array<[string, OpencodeModel[]]> = [
    [
      "anthropic",
      [{
        id: "claude-opus-4-7",
        providerID: "anthropic",
        name: "Claude Opus 4.7",
        status: "deprecated",
        capabilities: { input: ["text"] },
      }],
    ],
  ];

  it("renders a deprecated row disabled (outside the option set) with an enable action until opted in", () => {
    let enabledKey: string | undefined;
    h = mount(
      <ModelMenu
        open
        anchorRef={anchorRef()}
        groups={DEP_GROUPS}
        modelOverride={null}
        defaultModel={null}
        disabledKeys={["anthropic/claude-opus-4-7"]}
        onEnableDeprecated={(k) => {
          enabledKey = k;
        }}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    const text = surface().textContent ?? "";
    expect(text).toContain("Claude Opus 4.7");
    // NOT in the roving/selectable option set (aria role="option").
    const option = [...surface().querySelectorAll<HTMLElement>('[role="option"]')].find((e) =>
      e.textContent?.includes("Claude Opus 4.7"),
    );
    expect(option).toBeUndefined();
    // An enable action is offered and calls the caller's opt-in handler.
    const btn = [...surface().querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("Enable deprecated"),
    );
    expect(btn).toBeTruthy();
    btn!.click();
    expect(enabledKey).toBe("anthropic/claude-opus-4-7");
  });

  it("renders the row as a normal selectable option once its key is not disabled (opted in)", () => {
    h = mount(
      <ModelMenu
        open
        anchorRef={anchorRef()}
        groups={DEP_GROUPS}
        modelOverride={null}
        defaultModel={null}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    const option = [...surface().querySelectorAll<HTMLElement>('[role="option"]')].find((e) =>
      e.textContent?.includes("Claude Opus 4.7"),
    );
    expect(option).toBeTruthy();
    expect(option!.getAttribute("id")).toBe("anthropic/claude-opus-4-7");
  });
});

describe("ModelMenu Auto row (BET-1246)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function autoRow(): HTMLElement {
    const el = [...surface().querySelectorAll<HTMLElement>('[role="option"]')].find((e) =>
      e.textContent?.includes("Auto — Manta picks per task"),
    );
    expect(el, "expected the Auto pinned row").toBeTruthy();
    return el!;
  }

  function serverRow(): HTMLElement {
    const el = [...surface().querySelectorAll<HTMLElement>('[role="option"]')].find((e) =>
      e.textContent?.includes("Server default"),
    );
    expect(el, "expected the Server default pinned row").toBeTruthy();
    return el!;
  }

  function searchInput(): HTMLInputElement {
    const el = surface().querySelector<HTMLInputElement>('input[aria-label="Search models"]');
    expect(el, "expected the model search input").toBeTruthy();
    return el!;
  }

  function press(el: HTMLElement, key: string) {
    act(() => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  }

  it("renders the Auto row whether or not a server default is set", () => {
    // No server default model.
    h = mount(
      <ModelMenu
        open
        anchorRef={anchorRef()}
        groups={GROUPS}
        modelOverride={null}
        defaultModel={null}
        onSelectAuto={() => {}}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(autoRow().textContent).toContain("Auto — Manta picks per task");
    expect(autoRow().querySelector(".font-mono")?.textContent).toBe("auto");
    // Unmount and mount again WITH a server default model — the Auto row is
    // always the first pinned row regardless of the server default.
    h!.unmount();
    h = mount(
      <ModelMenu
        open
        anchorRef={anchorRef()}
        groups={GROUPS}
        modelOverride={null}
        defaultModel={{ providerID: "anthropic", modelID: "claude-opus-4-7" }}
        onSelectAuto={() => {}}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(autoRow().textContent).toContain("Auto — Manta picks per task");
  });

  it("is index 0 in the roving order — ArrowDown from the search field highlights Auto first, then Server default", () => {
    h = mount(
      <ModelMenu
        open
        anchorRef={anchorRef()}
        groups={GROUPS}
        modelOverride={null}
        defaultModel={null}
        onSelectAuto={() => {}}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    const input = searchInput();
    // Initial state: nothing highlighted (the aria-activedescendant attr is absent).
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    press(input, "ArrowDown");
    expect(input.getAttribute("aria-activedescendant")).toBe("auto");
    press(input, "ArrowDown");
    expect(input.getAttribute("aria-activedescendant")).toBe("server-default");
  });

  it("selecting Auto calls the auto handler and closes; selecting a model calls onSelect with that model", () => {
    let autoCalls = 0;
    let closed = 0;
    let selected: unknown = null;
    h = mount(
      <ModelMenu
        open
        anchorRef={anchorRef()}
        groups={GROUPS}
        modelOverride={null}
        defaultModel={null}
        onSelectAuto={() => {
          autoCalls++;
        }}
        onSelect={(m) => {
          selected = m;
        }}
        onClose={() => {
          closed++;
        }}
      />,
    );
    act(() => autoRow().click());
    expect(autoCalls).toBe(1);
    expect(closed).toBe(1);

    // Selecting a model row still calls onSelect with that model (Auto off).
    const modelRow = [...surface().querySelectorAll<HTMLElement>('[role="option"]')].find((e) =>
      e.textContent?.includes("Claude Opus 4.7"),
    )!;
    act(() => modelRow.click());
    expect(selected).toEqual({ providerID: "anthropic", modelID: "claude-opus-4-7" });
    expect(closed).toBe(2);
  });

  it("marks the Auto row aria-selected (and not Server default) when Auto is active", () => {
    h = mount(
      <ModelMenu
        open
        anchorRef={anchorRef()}
        groups={GROUPS}
        modelOverride={null}
        defaultModel={null}
        autoActive
        onSelectAuto={() => {}}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(autoRow().getAttribute("aria-selected")).toBe("true");
    expect(serverRow().getAttribute("aria-selected")).toBe("false");
  });

  it("shows the caller-supplied reason string in the Auto row's sub-line when Auto is active", () => {
    h = mount(
      <ModelMenu
        open
        anchorRef={anchorRef()}
        groups={GROUPS}
        modelOverride={null}
        defaultModel={null}
        autoActive
        presetLabel="Balanced"
        autoReason="moved: the previous provider ran out"
        onSelectAuto={() => {}}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    const rowText = autoRow().textContent ?? "";
    expect(rowText).toContain("Balanced · moved: the previous provider ran out");
  });

  it("renders the 'no decision yet' sub-line when Auto is active and no reason is supplied", () => {
    h = mount(
      <ModelMenu
        open
        anchorRef={anchorRef()}
        groups={GROUPS}
        modelOverride={null}
        defaultModel={null}
        autoActive
        presetLabel="Balanced"
        onSelectAuto={() => {}}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(autoRow().textContent).toContain("Balanced · chooses when the turn starts");
  });

  it("renders the static sub-line when Auto is not active", () => {
    h = mount(
      <ModelMenu
        open
        anchorRef={anchorRef()}
        groups={GROUPS}
        modelOverride={null}
        defaultModel={null}
        onSelectAuto={() => {}}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(autoRow().textContent).toContain("Chooses a model per task, never mid-turn");
  });

  it("omits the Auto row entirely when onSelectAuto is not supplied (delegate picker surface)", () => {
    h = mount(
      <ModelMenu
        open
        anchorRef={anchorRef()}
        groups={GROUPS}
        modelOverride={null}
        defaultModel={null}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    const auto = [...surface().querySelectorAll<HTMLElement>('[role="option"]')].find((e) =>
      e.textContent?.includes("Auto — Manta picks per task"),
    );
    expect(auto).toBeUndefined();
    // Server default remains the single pinned row (index 0 in the roving order).
    expect(serverRow().textContent).toContain("Server default");
  });
});
