// @vitest-environment jsdom
//
// Component tests for the Card chrome primitive (BET-531, stage 2 of M527).
//
// The primitive's "tokens" are class names that map through tailwind.config.js
// to the design tokens (rounded-xl → --r-lg 12px, border-border → --border,
// bg-bg-soft → --card via the card-rgb channel, px-4/py-3 → sp-4/sp-3). jsdom
// loads no stylesheet, so the contract is asserted on the exact class strings
// — a retune of Card's chrome fails here immediately.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { Card } from "./Card";
import { AskCardShell } from "./Cards";
import { GroupCard } from "./Settings";

const CHROME = "rounded-xl border border-border bg-bg-soft px-4 py-3";
const DANGER_CHROME = "rounded-xl border border-danger bg-danger-bg px-4 py-3";

function rootClass(h: Harness): string {
  const el = h.container.firstElementChild as HTMLElement | null;
  return el?.className ?? "";
}

/** The chrome <div> Card renders — the direct child of the mount point. */
function chromeEl(h: Harness): HTMLElement {
  const el = h.container.firstElementChild as HTMLElement;
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
    h = mount(
      <Card>content</Card>,
    );
    expect(rootClass(h)).toBe(CHROME);
  });

  it("danger variant renders the danger surface + danger edge", () => {
    h = mount(<Card danger>content</Card>);
    expect(rootClass(h)).toBe(DANGER_CHROME);
  });

  it("renders header/body/actions slots with the intra-card rhythm", () => {
    h = mount(
      <Card
        header={<span>H</span>}
        actions={<button>Go</button>}
      >
        body
      </Card>,
    );
    const chrome = chromeEl(h);
    const [header, body, actions] = Array.from(chrome.children);
    // header→body sp-3 (mt-3); body→actions sp-4 (mt-4).
    expect(header.className).toBe("flex items-start gap-3");
    expect(body.className).toBe("mt-3");
    expect(actions.className).toBe("flex items-center gap-2 mt-4");
    expect(body.textContent).toBe("body");
    expect(actions.textContent).toBe("Go");
  });

  it("renders children flush to the top when there is no header", () => {
    h = mount(<Card>alone</Card>);
    const chrome = chromeEl(h);
    expect(chrome.children.length).toBe(1);
    expect((chrome.children[0] as HTMLElement).className).toBe("");
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

describe("Card migration (BET-531 two-adopter rule)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("AskCardShell renders through Card's chrome (no className injection)", () => {
    h = mount(
      <AskCardShell
        badge={<span>!</span>}
        badgeBg="var(--warn-bg)"
        badgeColor="var(--warn)"
        title="Allow?"
        actions={<button>OK</button>}
        body={<div>detail</div>}
      >
      </AskCardShell>,
    );
    const chrome = chromeEl(h).querySelector("div.rounded-xl");
    expect(chrome?.className).toBe(CHROME);
    expect(h.text()).toContain("Allow?");
    expect(h.text()).toContain("OK");
  });

  it("GroupCard renders through Card's chrome and maps the danger variant", () => {
    h = mount(
      <GroupCard title="Danger zone" danger>
        <button>Reset</button>
      </GroupCard>,
    );
    const chrome = h.container.querySelector("div.rounded-xl") as HTMLElement | null;
    expect(chrome?.className).toBe(DANGER_CHROME);
    const heading = h.container.querySelector("h5");
    expect(heading?.textContent).toBe("Danger zone");
    expect(h.text()).toContain("Reset");
  });

  it("GroupCard drops its dead className prop (no caller passed it)", () => {
    // The prop was removed from the type — passing it is now a compile error,
    // which is exactly the no-escape-hatch requirement at zero call-site cost.
    // @ts-expect-error — GroupCard no longer accepts className
    void <GroupCard title="x" className="block">y</GroupCard>;
    expect(true).toBe(true);
  });
});
