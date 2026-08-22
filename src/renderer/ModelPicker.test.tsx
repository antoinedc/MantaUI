// @vitest-environment jsdom
//
// ModelPicker loading state — the three segments (model ▸ effort ▸ ⚡ fast)
// describe ONE subject, so they enter placeholder together while the shared
// catalog is in flight (`models === null`, the only loading signal
// `useModelCatalog` exposes).
//
// The reason this is pinned rather than left to review: the non-loading
// fallbacks are not neutral, they are confident and WRONG before the catalog
// lands — the model button settles on the "opencode" stub, the effort label
// hard-codes "High", and `resolveFastToggle` reports the model as having no
// fast twin. Those read as resolved facts about a model nobody has resolved,
// which is exactly the state a user is most likely to act on. Each assertion
// below is one of those three lies.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { mount, type Harness } from "./testHarness";
import { ModelPicker } from "./ModelPicker";
import type { ModelSelection } from "./chatShared";
import type { OpencodeModel } from "../shared/types";

const MODELS: OpencodeModel[] = [
  {
    id: "claude-opus-4-7",
    providerID: "anthropic",
    name: "Claude Opus 4.7",
    variants: [{ id: "high" }, { id: "low" }],
  } as OpencodeModel,
];

describe("ModelPicker — loading state (models === null)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  // The server default is supplied in both cases: it is what the composer
  // actually has in hand, and it isolates the variable under test to `models`.
  // (With no default AND no override the loaded chip legitimately shows the
  // "opencode" stub — a different, already-resolved state.)
  function render(models: OpencodeModel[] | null): HTMLElement {
    h?.unmount();
    h = mount(
      <ModelPicker
        modelLabel={null}
        models={models}
        modelOverride={null}
        defaultModel={{ providerID: "anthropic", modelID: "claude-opus-4-7" }}
        onOpen={() => {}}
        onSelect={() => {}}
        onSelectEffort={() => {}}
      />,
    );
    return h.container;
  }

  it("states no model, effort or fast-mode value while the catalog is in flight", () => {
    const c = render(null);
    const text = c.textContent ?? "";
    // The three fabricated values, none of which may appear.
    expect(text).not.toContain("opencode");
    expect(text).not.toContain("High");
    expect(text).not.toContain("Default");

    // …and the toggle reports "unknown", not "off": an aria-pressed="false"
    // here would assert the model has fast mode available and switched off.
    const fastBtn = c.querySelector<HTMLElement>(".manta-fast-toggle-btn");
    expect(fastBtn).toBeTruthy();
    expect(fastBtn?.hasAttribute("aria-pressed")).toBe(false);
  });

  it("marks the whole split control busy, not one segment", () => {
    const c = render(null);
    const shell = c.firstElementChild?.firstElementChild as HTMLElement;
    expect(shell.getAttribute("aria-busy")).toBe("true");
    // All three segments are present and identity-stable, so the chip does not
    // change shape when the catalog lands — only its content.
    expect(c.querySelector(".manta-model-picker-btn")).toBeTruthy();
    expect(c.querySelector(".manta-effort-picker-btn")).toBeTruthy();
    expect(c.querySelector(".manta-fast-toggle-btn")).toBeTruthy();
  });

  it("resolves to real values once the catalog lands", () => {
    const c = render(MODELS);
    const shell = c.firstElementChild?.firstElementChild as HTMLElement;
    expect(shell.hasAttribute("aria-busy")).toBe(false);
    const text = c.textContent ?? "";
    expect(text).toContain("Claude Opus 4.7");
  });
});

describe("ModelPicker — routed pill (BET-1222)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function render(
    routed:
      | { reason: string; incumbent: { providerID: string; modelID: string } | null }
      | null,
    onRoutedUndone: () => void = () => {},
  ): HTMLElement {
    h?.unmount();
    h = mount(
      <ModelPicker
        modelLabel={null}
        models={MODELS}
        modelOverride={null}
        defaultModel={{ providerID: "anthropic", modelID: "claude-opus-4-7" }}
        onOpen={() => {}}
        onSelect={() => {}}
        routed={routed}
        onRoutedUndone={onRoutedUndone}
        onSelectEffort={() => {}}
      />,
    );
    return h.container;
  }

  it("renders the routed treatment when routed is set (◆ prefix, · routed, reason, undo)", () => {
    const c = render({
      reason: "build → deep tier: anthropic weekly at 89%",
      incumbent: { providerID: "anthropic", modelID: "claude-opus-4-7" },
    });
    const text = c.textContent ?? "";
    expect(text).toContain("◆ ");
    expect(text).toContain(" · routed");
    expect(text).toContain("build → deep tier: anthropic weekly at 89%");
    expect(text).toContain("undo · keep anthropic/claude-opus-4-7 here");
  });

  it("renders no routed pill when routed is null", () => {
    const c = render(null);
    const text = c.textContent ?? "";
    expect(text).not.toContain("routed");
    expect(text).not.toContain("undo");
  });

  it("invokes onRoutedUndone when the undo button is pressed", () => {
    let undone = false;
    const c = render(
      {
        reason: "r",
        incumbent: { providerID: "anthropic", modelID: "claude-opus-4-7" },
      },
      () => {
        undone = true;
      },
    );
    const btn = [...c.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("undo"),
    );
    expect(btn).toBeTruthy();
    act(() => (btn as HTMLButtonElement).click());
    expect(undone).toBe(true);
  });

  it("renders the reason without an undo action when routed has no incumbent (BET-1274 10e)", () => {
    // The first turn of a session has nothing to undo — the pill still says why
    // the model is what it is, but offers no undo button.
    const c = render({
      reason: "first turn boundary",
      incumbent: null,
    });
    const text = c.textContent ?? "";
    expect(text).toContain("first turn boundary");
    expect(text).not.toContain("undo");
  });
});

describe("ModelPicker — Auto mode (BET-1247)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function render(props: {
    models?: OpencodeModel[] | null;
    modelOverride?: ModelSelection | null;
    defaultModel?: { providerID: string; modelID: string } | null;
    auto?: boolean;
    labelOverride?: string | null;
  }): HTMLElement {
    h?.unmount();
    h = mount(
      <ModelPicker
        modelLabel={null}
        models={props.models === undefined ? MODELS : props.models}
        modelOverride={props.modelOverride ?? null}
        defaultModel={props.defaultModel ?? null}
        auto={props.auto ?? false}
        labelOverride={props.labelOverride ?? null}
        onOpen={() => {}}
        onSelect={() => {}}
        onSelectEffort={() => {}}
      />,
    );
    return h.container;
  }

  // The left segment button's text — the model part of the split chip. Its
  // two icons (Sparkles, ChevronDown) are empty glyphs, so the textContent is
  // exactly the label string under test.
  function leftLabel(c: HTMLElement): string {
    const btn = c.querySelector<HTMLElement>(".manta-model-picker-btn");
    return btn?.textContent ?? "";
  }

  it("reads just 'Auto' when Auto is on and no model is resolved yet", () => {
    const c = render({ auto: true, modelOverride: null, defaultModel: null });
    const label = leftLabel(c);
    expect(label).toContain("Auto");
    // No specific model is claimed while Auto has not chosen one — a "·" would
    // assert a model that nobody has resolved.
    expect(label).not.toContain("·");
  });

  it("reads 'Auto · <model>' once Auto has resolved a model", () => {
    const c = render({
      auto: true,
      modelOverride: { providerID: "anthropic", modelID: "claude-opus-4-7" },
      defaultModel: null,
    });
    expect(leftLabel(c)).toContain("Auto · Claude Opus 4.7");
  });

  it("leaves the label byte-identical when Auto is off", () => {
    const c = render({
      auto: false,
      modelOverride: null,
      defaultModel: { providerID: "anthropic", modelID: "claude-opus-4-7" },
    });
    // Today's label, exactly: the resolved default model's friendly name.
    expect(leftLabel(c)).toBe("Claude Opus 4.7");
    expect(leftLabel(c)).not.toContain("Auto");
  });

  it("never renders the Auto label while the catalog is in flight", () => {
    const c = render({ auto: true, models: null });
    const text = c.textContent ?? "";
    expect(text).not.toContain("Auto");
    expect(c.querySelector(".manta-model-picker-btn")).toBeTruthy();
  });

  it("leaves the effort and fast-toggle segments unchanged under Auto", () => {
    const c = render({
      auto: true,
      modelOverride: { providerID: "anthropic", modelID: "claude-opus-4-7" },
      defaultModel: null,
    });
    // Resolved model exposes variants → the effort segment stays interactive
    // with its default label; the ⚡ fast toggle is still present.
    expect(c.textContent ?? "").toContain("Default");
    expect(c.querySelector(".manta-fast-toggle-btn")).toBeTruthy();
  });

  it("names the full resolved model + provider in the auto hover title", () => {
    const c = render({
      auto: true,
      modelOverride: { providerID: "anthropic", modelID: "claude-opus-4-7" },
      defaultModel: null,
    });
    const title = c
      .querySelector<HTMLElement>(".manta-model-picker-btn")
      ?.getAttribute("title") ?? "";
    expect(title).toContain("Claude Opus 4.7");
    expect(title).toContain("anthropic");
  });
});

describe("ModelPicker — effort/fast write effort, not a model choice (BET-1274 10c)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("routes an effort-menu selection to onSelectEffort, never onSelect", () => {
    const effortCalls: ModelSelection[] = [];
    const modelCalls: ModelSelection[] = [];
    h = mount(
      <ModelPicker
        modelLabel={null}
        models={MODELS}
        modelOverride={{ providerID: "anthropic", modelID: "claude-opus-4-7" }}
        defaultModel={null}
        onOpen={() => {}}
        onSelect={(m) => { if (m) modelCalls.push(m); }}
        onSelectEffort={(m) => effortCalls.push(m)}
      />,
    );
    // Open the effort (right) segment menu. The dropdown portals to document.body.
    const effortBtn = h.container.querySelector<HTMLElement>(".manta-effort-picker-btn");
    expect(effortBtn).toBeTruthy();
    act(() => (effortBtn as HTMLButtonElement).click());
    const effortMenu = document.body.querySelector<HTMLElement>(".manta-effort-dropdown");
    expect(effortMenu).toBeTruthy();
    // Select the "High" variant row.
    const high = [...(effortMenu?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].find((b) =>
      (b.textContent ?? "").includes("High"),
    );
    expect(high).toBeTruthy();
    act(() => (high as HTMLElement).click());
    // The effort went to onSelectEffort (with the variant) — and NOT to the
    // model-choice onSelect, which is what used to pin the model + exit Auto.
    expect(effortCalls).toHaveLength(1);
    expect(effortCalls[0].variant).toBe("high");
    expect(modelCalls).toHaveLength(0);
  });

  it("names the capitalized balance preset in the Auto row sub-line (BET-1274 10d)", () => {
    h = mount(
      <ModelPicker
        modelLabel={null}
        models={MODELS}
        modelOverride={null}
        defaultModel={null}
        auto
        presetLabel="Balanced"
        autoReason="moved: the previous provider ran out"
        onSelectAuto={() => {}}
        onOpen={() => {}}
        onSelect={() => {}}
        onSelectEffort={() => {}}
      />,
    );
    // Open the model dropdown; the Auto pinned row is its first header row.
    const modelBtn = h.container.querySelector<HTMLElement>(".manta-model-picker-btn");
    act(() => (modelBtn as HTMLButtonElement).click());
    const modelMenu = document.body.querySelector<HTMLElement>(".manta-model-dropdown");
    const autoRow = [...(modelMenu?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].find((e) =>
      (e.textContent ?? "").includes("Auto — Manta picks per task"),
    );
    expect(autoRow).toBeTruthy();
    expect(autoRow?.textContent ?? "").toContain("Balanced · moved: the previous provider ran out");
  });

  it("after a model choice Auto is off and the dropdown has exactly one selected row (BET-1274 test 1)", () => {
    // The post-pick UI state (BET-1274 10b): non-Auto + an explicit override.
    // Auto and Server-default rows are deselected; only the picked model row is.
    h = mount(
      <ModelPicker
        modelLabel={null}
        models={MODELS}
        modelOverride={{ providerID: "anthropic", modelID: "claude-opus-4-7" }}
        defaultModel={null}
        auto={false}
        onOpen={() => {}}
        onSelect={() => {}}
        onSelectEffort={() => {}}
      />,
    );
    // The chip no longer claims Auto — a plain model name.
    const btn = h.container.querySelector<HTMLElement>(".manta-model-picker-btn");
    expect(btn?.textContent ?? "").not.toContain("Auto");
    expect(btn?.textContent ?? "").toContain("Claude Opus 4.7");

    // Open the dropdown: exactly one row is selected (the picked model).
    act(() => (btn as HTMLButtonElement).click());
    const menu = document.body.querySelector<HTMLElement>(".manta-model-dropdown");
    const selected = [...(menu?.querySelectorAll<HTMLElement>('[role="option"][aria-selected="true"]') ?? [])];
    expect(selected.length).toBe(1);
    expect(selected[0].textContent ?? "").toContain("Claude Opus 4.7");
  });
});
