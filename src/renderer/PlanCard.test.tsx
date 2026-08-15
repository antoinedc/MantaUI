// @vitest-environment jsdom
//
// Component tests for the PlanCard (BET-951) — the upgraded plan_exit card in
// the pinned card stack. Detection itself (isPlanExitQuestion / extractPlanData)
// is pinned in chatUtils.test.ts; here we pin the card surface: badge, title,
// metrics + path, the action row, the delegate split's per-segment popup
// semantics, the cap-disabled title, and that the generic QuestionCard path
// still renders an ordinary (non-plan) question untouched.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { act } from "react";
import { mount, type Harness } from "./testHarness";
import { PlanCard, QuestionCard } from "./Cards";
import type { ModelSelection } from "./chatShared";
import type { QuestionRequest, OpencodeModel } from "../shared/types";

const GROUPS: Array<[string, OpencodeModel[]]> = [
  [
    "anthropic",
    [
      { id: "claude-opus-4-7", providerID: "anthropic", name: "Claude Opus 4.7", family: "Claude" },
      { id: "claude-sonnet-4-6", providerID: "anthropic", name: "Claude Sonnet 4.6", family: "Claude" },
    ],
  ],
];

const DATA = {
  title: "Add login",
  path: "/work/plan.md",
  metrics: { steps: 2, files: 1 },
  text: "# Add login\n## Step 1\n- `src/a.ts`",
};

function modelBtn(h: Harness | null): HTMLButtonElement {
  return (h as Harness).container.querySelector(".manta-plan-delegate-model-btn") as HTMLButtonElement;
}
function delegateBtn(h: Harness | null): HTMLButtonElement {
  return (h as Harness).container.querySelector(".manta-plan-delegate-btn") as HTMLButtonElement;
}

describe("PlanCard (BET-951)", () => {
  let h: Harness | null = null;
  beforeEach(() => {
    // The ModelMenu portals to <body>; keep it clean between tests.
    document.body.innerHTML = "";
  });
  afterEach(() => {
    h?.unmount();
    document.body.innerHTML = "";
    h = null;
  });

  const render = (props: Partial<Parameters<typeof PlanCard>[0]> = {}) =>
    mount(
      <PlanCard
        data={DATA}
        models={GROUPS}
        remembered={null}
        sessionModel={null}
        buildModelName="Claude Opus 4.7"
        atDelegateCap={false}
        onBuildHere={() => {}}
        onKeepPlanning={() => {}}
        onStartDelegate={() => {}}
        onRememberDelegateModel={() => {}}
        onOpenInBrowser={() => {}}
        {...props}
      />,
    );

  it("renders badge, title, metrics + path and the action row", () => {
    h = render();
    expect(h.text()).toContain("Add login");
    expect(h.text()).toContain("2 steps");
    expect(h.text()).toContain("1 files");
    expect(h.text()).toContain("/work/plan.md");
    expect(h.text()).toContain("Build here");
    expect(h.text()).toContain("Delegate");
    expect(h.text()).toContain("Keep planning");
  });

  it("omits the '0 steps' clause when metrics cannot be derived", () => {
    h = render({ data: { ...DATA, metrics: {} } });
    expect(h.text()).not.toContain("0 steps");
  });

  it("delegate split: the model segment carries aria-haspopup, the action segment does NOT", () => {
    h = render();
    expect(modelBtn(h).getAttribute("aria-haspopup")).toBe("listbox");
    expect(delegateBtn(h).hasAttribute("aria-haspopup")).toBe(false);
  });

  it("opens the ModelMenu (portalled to body) anchored to the model segment", () => {
    h = render();
    act(() => modelBtn(h).click());
    const surface = document.body.querySelector(".manta-model-dropdown") as HTMLElement;
    expect(surface).toBeTruthy();
    expect(surface.textContent).toContain("Same as this session");
    expect(surface.textContent).toContain("Claude Opus 4.7");
  });

  it("atDelegateCap titles both split segments that the cap is hit, and ignores clicks", () => {
    h = render({ atDelegateCap: true });
    expect(modelBtn(h).getAttribute("title")).toContain("Too many background jobs");
    expect(delegateBtn(h).getAttribute("title")).toContain("Too many background jobs");
    let fired = false;
    h?.unmount();
    h = render({ atDelegateCap: true, onStartDelegate: () => { fired = true; } });
    act(() => delegateBtn(h).click());
    expect(fired).toBe(false);
  });

  it("a remembered model is shown on the split's right segment", () => {
    const remembered: ModelSelection = { providerID: "anthropic", modelID: "claude-sonnet-4-6" };
    h = render({ remembered });
    expect(h.text()).toContain("Claude");
  });
});

describe("QuestionCard still renders an ordinary (non-plan) question (BET-951)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders the generic question form for a question with no plan_exit tool link", () => {
    const q: QuestionRequest = {
      id: "q1",
      sessionID: "s1",
      requestId: "que_1",
      questions: [
        {
          question: "Which column ordering?",
          header: "CSV export",
          options: [{ label: "A", description: "a" }],
        },
      ],
    };
    h = mount(<QuestionCard request={q} onReply={() => {}} onReject={() => {}} />);
    expect(h.text()).toContain("CSV export");
    expect(h.text()).toContain("Submit");
    // A plan card surface must not appear for an ordinary question.
    expect(h.container.querySelector(".manta-plan-delegate-btn")).toBeNull();
  });
});
