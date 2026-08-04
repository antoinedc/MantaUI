// @vitest-environment jsdom
//
// Component tests for the Card chrome primitive (BET-531, stage 2 of M527).
//
// The primitive's "tokens" are class names that map through tailwind.config.js
// to the design tokens (rounded-lg → --r-lg 12px, border-border → --border,
// bg-bg-soft → --card via the card-rgb channel, px-4/py-3 → sp-4/sp-3). jsdom
// loads no stylesheet, so the contract is asserted on the exact class strings
// — a retune of Card's chrome fails here immediately.
//
// The GroupCard consolidation (Settings.tsx) is not imported here — Settings
// pulls in shell/Qr deps that aren't jsdom-loadable — so its no-visual-change
// proof is the visual gate (`npm run visual`, settings baselines), per BET-531.
// The AskCardShell migration smoke is exercised through the real exported
// PermissionCard / QuestionCard call sites below.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { mount, type Harness } from "./testHarness";
import { Card } from "./Card";
import { PermissionCard, QuestionCard } from "./Cards";
import type { PermissionRequest, QuestionRequest } from "../shared/types";

const CHROME = "rounded-lg border border-border bg-bg-soft px-4 py-3";
const DANGER_CHROME = "rounded-lg border border-danger bg-danger-bg px-4 py-3";

function chromeEl(h: Harness): HTMLElement {
  const el = h.container.querySelector("div.rounded-lg") as HTMLElement;
  expect(el).toBeTruthy();
  return el;
}

describe("Card", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders the chrome surface/edge/radius/padding per the contract", () => {
    h = mount(<Card>content</Card>);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toBe(CHROME);
  });

  it("danger variant renders the danger surface + danger edge", () => {
    h = mount(<Card danger>content</Card>);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toBe(DANGER_CHROME);
  });

  it("renders header/body/actions slots with the intra-card rhythm", () => {
    h = mount(
      <Card header={<span>H</span>} actions={<button>Go</button>}>
        body
      </Card>,
    );
    const chrome = h.container.firstElementChild as HTMLElement;
    const [header, body, actions] = Array.from(chrome.children);
    // header→body sp-3 (mt-3); body→actions sp-4 (mt-4).
    expect(header.className).toBe("flex items-start gap-3");
    expect(body.className).toBe("mt-3");
    expect(actions.className).toBe("flex items-center gap-2 mt-4");
    expect(body.textContent).toBe("body");
    expect(actions.textContent).toBe("Go");
  });

  it("elevated adds the --shadow-md lift; default stays flat", () => {
    h = mount(<Card>flat</Card>);
    expect((h.container.firstElementChild as HTMLElement).className).toBe(CHROME);
    h.unmount();
    h = mount(<Card elevated>lifted</Card>);
    expect((h.container.firstElementChild as HTMLElement).className).toBe(
      `${CHROME} shadow-md`,
    );
  });

  it("renders children flush to the top when there is no header", () => {
    h = mount(<Card>alone</Card>);
    const chrome = h.container.firstElementChild as HTMLElement;
    expect(chrome.children.length).toBe(0);
    expect(chrome.textContent).toBe("alone");
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // If Card ever grew a className prop this directive becomes unused and
    // typecheck fails — the standing-decision-3 guard lives in the types.
    // @ts-expect-error — Card must NOT accept className (M527 decision 3)
    void <Card className="bg-red-500">x</Card>;
    expect(true).toBe(true);
  });
});

describe("Card migration — ask-card call sites (BET-531 two-adopter rule)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  const perm: PermissionRequest = {
    id: "p1",
    sessionID: "s1",
    permission: "bash",
    metadata: { command: "ls -la" },
    always: [],
  };

  const question: QuestionRequest = {
    id: "q1",
    sessionID: "s1",
    requestId: "que_1",
    questions: [
      {
        question: "Which column ordering?",
        header: "CSV export",
        options: [
          { label: "A", description: "option a" },
          { label: "B (Recommended)", description: "option b" },
        ],
      },
    ],
  };

  it("PermissionCard renders through Card's non-danger chrome + elevated lift (no className injection)", () => {
    h = mount(<PermissionCard perm={perm} onReply={() => {}} />);
    // Ask cards float over the transcript, so they carry the elevated lift.
    expect(chromeEl(h).className).toBe(`${CHROME} shadow-md`);
    expect(h.text()).toContain("Allow once");
    expect(h.text()).toContain("Reject");
    expect(h.text()).toContain("ls -la");
  });

  it("QuestionCard renders through Card's elevated chrome with the action footer", () => {
    h = mount(<QuestionCard request={question} onReply={() => {}} onReject={() => {}} />);
    expect(chromeEl(h).className).toBe(`${CHROME} shadow-md`);
    expect(h.text()).toContain("Submit");
    expect(h.text()).toContain("Dismiss");
  });

  it("clicking a QuestionCard option toggles selection without throwing; Submit renders", () => {
    h = mount(<QuestionCard request={question} onReply={() => {}} onReject={() => {}} />);
    // Full-width `.opt` option rows are labels wrapping an sr-only control.
    const inputs = Array.from(
      h.container.querySelectorAll("input[type='radio'], input[type='checkbox']"),
    ) as HTMLInputElement[];
    expect(inputs.length).toBe(2);
    // Single-select preselects the recommended option (B). Click option A.
    act(() => inputs[0].click());
    expect(inputs[0].checked).toBe(true);
    // No throw, and the primary Submit action still renders.
    expect(h.text()).toContain("Submit");
  });

  it("QuestionCard survives a malformed payload (missing options) without throwing", () => {
    const bad = {
      id: "qbad",
      sessionID: "s1",
      requestId: "que_bad",
      // A question with NO options array — the defensive guard must not throw.
      questions: [{ question: "Broken?", header: "Broken" }],
    } as unknown as QuestionRequest;
    h = mount(<QuestionCard request={bad} onReply={() => {}} onReject={() => {}} />);
    // Still renders the shell + actions rather than blanking.
    expect(h.text()).toContain("Broken");
    expect(h.text()).toContain("Submit");
  });
});
