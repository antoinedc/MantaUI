// @vitest-environment jsdom
//
// Component tests for the ToolCard chrome primitive (BET-636).
//
// Asserts the card shell + header strip: the status dot, bold name, muted
// arg, right meta slot, and the button/chevron disclosure when onToggle is
// supplied. The two adopters (ToolCall.tsx for the generic tool call,
// TaskCard.tsx for the subagent card) render through the real components.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { ToolCard } from "./ToolCard";

const SHELL = "rounded-md border border-border-subtle bg-bg-elev overflow-hidden";
const HEADER =
  "flex items-center gap-2 px-3 py-[9px] text-[12.5px] leading-none font-mono text-text-muted";

describe("ToolCard", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function root(): HTMLElement {
    const el = h!.container.firstElementChild as HTMLElement;
    expect(el).toBeTruthy();
    return el;
  }

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // @ts-expect-error — ToolCard must NOT accept className (M527 decision 3)
    void <ToolCard name="x" className="bg-red-500" />;
    expect(true).toBe(true);
  });

  it("renders the raised card shell with a plain div header when not togglable", () => {
    h = mount(<ToolCard name="Read" arg="app/routes/orders.py" />);
    expect(root().className).toBe(SHELL);
    const header = root().firstElementChild as HTMLElement;
    expect(header.tagName).toBe("DIV");
    expect(header.className).toBe(HEADER);
  });

  it("renders name (bold), arg (muted) and meta in the header", () => {
    h = mount(
      <ToolCard
        tone="ok"
        name="Edit"
        arg="app/routes/orders.py"
        meta={<><span className="text-ok">+38</span><span className="text-danger">−4</span></>}
      />,
    );
    const text = h.text() ?? "";
    expect(text).toContain("Edit");
    expect(text).toContain("app/routes/orders.py");
    expect(text).toContain("+38");
    expect(text).toContain("−4");
  });

  it("renders a StatusDot when tone is provided and none when omitted", () => {
    h = mount(<ToolCard tone="running" name="Bash" />);
    expect(root().querySelector(".w-\\[6px\\]")?.classList.contains("bg-accent")).toBe(true);
    h!.unmount();
    h = mount(<ToolCard name="Bash" />);
    expect(h!.container.querySelector(".animate-pulse")).toBeNull();
  });

  it("renders a disclosure button with aria-expanded when onToggle is supplied", () => {
    let clicks = 0;
    h = mount(<ToolCard name="Task" onToggle={() => clicks++} expanded={false} />);
    // The header is a plain flex DIV; the clickable disclosure is the inner
    // button holding name/arg/meta (it cannot nest the copy/chevron buttons).
    const header = root().firstElementChild as HTMLElement;
    expect(header.tagName).toBe("DIV");
    const toggle = header.querySelector('button[aria-expanded="false"]') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    // The callback fires on click; the rendered aria-expanded reflects the
    // (controlled) `expanded` prop, which this closure never changes.
    toggle.click();
    expect(clicks).toBe(1);
  });

  it("renders the copy button LEFT of the collapse chevron when both are present", () => {
    let clicks = 0;
    h = mount(
      <ToolCard name="Bash" copyText="output" onToggle={() => clicks++} expanded={false} />,
    );
    const header = root().firstElementChild as HTMLElement;
    const copy = header.querySelector('[aria-label="Copy"]') as HTMLElement;
    const chevron = header.querySelector('[aria-label="Expand"]') as HTMLElement;
    expect(copy).toBeTruthy();
    expect(chevron).toBeTruthy();
    // The chevron sits at the right of the copy icon — i.e. AFTER it in the
    // header's flex-child order.
    const children = Array.from(header.children);
    expect(children.indexOf(copy)).toBeLessThan(children.indexOf(chevron));
  });

  it("renders children as the card body", () => {
    h = mount(<ToolCard name="Edit">body</ToolCard>);
    expect(root().textContent).toContain("body");
  });
});
