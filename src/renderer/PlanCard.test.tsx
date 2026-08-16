// @vitest-environment jsdom
//
// Component tests for the PlanCard (BET-951) — the upgraded plan_exit card in
// the pinned card stack. Detection itself (isPlanExitQuestion / extractPlanData)
// is pinned in chatUtils.test.ts; here we pin the card surface: badge, title,
// the feedback input + Send button, the action row (Build here / Delegate /
// Open page), the delegate split's per-segment popup semantics, the cap-disabled
// title, the per-action loading states (busy), and that the generic QuestionCard
// path still renders an ordinary (non-plan) question untouched.

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
  text: "# Add login\n## Step 1\n- `src/a.ts`",
};

function modelBtn(h: Harness | null): HTMLButtonElement {
  return (h as Harness).container.querySelector(".manta-plan-delegate-model-btn") as HTMLButtonElement;
}
function delegateBtn(h: Harness | null): HTMLButtonElement {
  return (h as Harness).container.querySelector(".manta-plan-delegate-btn") as HTMLButtonElement;
}
function sendBtn(h: Harness | null): HTMLButtonElement {
  return (h as Harness).container.querySelector(".manta-plan-send-feedback") as HTMLButtonElement;
}
function openBtn(h: Harness | null): HTMLButtonElement {
  return (h as Harness).container.querySelector(".manta-plan-open-page") as HTMLButtonElement;
}
function buildBtn(h: Harness | null): HTMLButtonElement {
  return Array.from((h as Harness).container.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === "Build here",
  ) as HTMLButtonElement;
}

// Set a controlled <input>'s value the way React expects (native setter +
// input event) so onChange fires and the component's `feedback` state updates.
function typeInto(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
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
        onSendFeedback={() => {}}
        onStartDelegate={() => {}}
        onRememberDelegateModel={() => {}}
        onOpenInBrowser={() => {}}
        {...props}
      />,
    );

  it("renders badge, title and the action row (no metrics, no path, no Keep planning)", () => {
    h = render();
    expect(h.text()).toContain("Add login");
    expect(h.text()).toContain("Build here");
    expect(h.text()).toContain("Delegate");
    expect(h.text()).toContain("Open page");
    expect(h.text()).toContain("Send");
    expect(h.text()).not.toContain("steps");
    expect(h.text()).not.toContain("files");
    expect(h.text()).not.toContain("plan.md");
    expect(h.text()).not.toContain("Keep planning");
  });

  it("renders the Send button, disabled until feedback is typed", () => {
    h = render();
    expect(sendBtn(h).disabled).toBe(true);
    const input = h.container.querySelector('input[placeholder*="Anything to change"]') as HTMLInputElement;
    typeInto(input, "make it faster");
    expect(sendBtn(h).disabled).toBe(false);
  });

  it("Send submits the typed feedback", () => {
    let fb = "";
    h = render({ onSendFeedback: (f: string) => { fb = f; } });
    const input = h.container.querySelector('input[placeholder*="Anything to change"]') as HTMLInputElement;
    typeInto(input, "make it faster");
    act(() => sendBtn(h).click());
    expect(fb).toBe("make it faster");
  });

  it("build loading: Build here loads, others disabled while busy === 'build'", () => {
    h = render({ busy: "build" });
    expect(buildBtn(h).getAttribute("aria-busy")).toBe("true");
    expect(buildBtn(h).disabled).toBe(true);
    expect(delegateBtn(h).disabled).toBe(true);
    expect(sendBtn(h).disabled).toBe(true);
  });

  it("delegate loading: Delegate loads, others disabled while busy === 'delegate'", () => {
    h = render({ busy: "delegate" });
    // SplitButton puts aria-busy on its shell <div>, and loading disables both segments.
    expect(delegateBtn(h).parentElement!.getAttribute("aria-busy")).toBe("true");
    expect(delegateBtn(h).disabled).toBe(true);
    expect(buildBtn(h).disabled).toBe(true);
    expect(sendBtn(h).disabled).toBe(true);
  });

  it("feedback loading: Send loads, others disabled while busy === 'feedback'", () => {
    h = render({ busy: "feedback" });
    expect(sendBtn(h).getAttribute("aria-busy")).toBe("true");
    expect(buildBtn(h).disabled).toBe(true);
    expect(delegateBtn(h).disabled).toBe(true);
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

  it("Open page is always enabled and labelled 'Open page', firing onOpenInBrowser", () => {
    let fired = false;
    h = render({ onOpenInBrowser: () => { fired = true; } });
    expect(h.text()).toContain("Open page");
    expect(openBtn(h).disabled).toBe(false);
    act(() => openBtn(h).click());
    expect(fired).toBe(true);
  });

  it("renders the deterministic published URL in the body", () => {
    h = render({ planUrl: "https://box/pages/plan-sesa" });
    expect(h.text()).toContain("https://box/pages/plan-sesa");
    expect(h.text()).toContain("Open page");
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
