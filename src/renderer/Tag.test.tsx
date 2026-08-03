// @vitest-environment jsdom
//
// Component tests for the Tag chrome primitive (BET-614, stage 4 of M527).
//
// jsdom loads no stylesheet, so the contract is asserted on the exact class
// strings — a retune of Tag's chrome fails here immediately. The adopter
// (SessionHeader.tsx, the branch indicator) is migrated through the real
// exported component.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { Tag } from "./Tag";

// The size axis was added after this contract was first pinned, so the size
// segment now sits between the shared base and the tone rather than inside the
// base string. The RESOLVED class set for a default `md` tag is unchanged —
// only its order is — which is what these two constants assert.
const BASE = "inline-flex items-center font-mono leading-none font-medium";
const SURFACE = "rounded-full border border-border";
const TAG_MD = `${BASE} ${SURFACE} gap-[5px] h-[23px] px-2 text-[11.5px] bg-fill text-text-faint`;
const TAG_SM = `${BASE} ${SURFACE} gap-1 h-5 px-2 text-[11px] bg-fill text-text-faint`;

function tagEl(h: Harness): HTMLElement {
  const el = h.container.firstElementChild as HTMLElement;
  expect(el).toBeTruthy();
  return el;
}

describe("Tag", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders the exact tag chrome", () => {
    h = mount(<Tag>main</Tag>);
    expect(tagEl(h).className).toBe(TAG_MD);
  });

  it("md is the default size — an explicit md renders identically", () => {
    h = mount(<Tag size="md">main</Tag>);
    expect(tagEl(h).className).toBe(TAG_MD);
  });

  it("sm renders the 20px header-density variant and changes nothing else", () => {
    h = mount(<Tag size="sm">main</Tag>);
    const cls = tagEl(h).className;
    expect(cls).toBe(TAG_SM);
    // The size axis moves ONLY the four metrics it owns; the pill, the edge,
    // the face and the tone are the same decisions at both sizes.
    expect(cls).toContain("rounded-full");
    expect(cls).toContain("border-border");
    expect(cls).toContain("font-mono");
    expect(cls).toContain("text-text-faint");
    expect(cls).not.toContain("h-[23px]");
    expect(cls).not.toContain("text-[11.5px]");
  });

  // `plain` exists for a tag sitting on a host surface that already draws a
  // fill and an edge (the session header's glass pill). Drawing Tag's own on
  // top produces a border inside a border and a fill over a blur.
  it("plain drops the tag's own edge and fill but keeps its metrics and face", () => {
    h = mount(<Tag plain>main</Tag>);
    const cls = tagEl(h).className;
    expect(cls).toBe(`${BASE} gap-[5px] h-[23px] px-2 text-[11.5px] text-text-faint`);
    expect(cls).not.toContain("border");
    expect(cls).not.toContain("rounded-full");
    expect(cls).not.toContain("bg-fill");
  });

  it("plain still carries the tone's FOREGROUND — only the surface is dropped (C1)", () => {
    h = mount(<Tag plain tone="accent">main</Tag>);
    expect(tagEl(h).className).toContain("text-accent-tx");
  });

  it("plain composes with size — the two axes are independent", () => {
    h = mount(<Tag plain size="sm">main</Tag>);
    const cls = tagEl(h).className;
    expect(cls).toBe(`${BASE} gap-1 h-5 px-2 text-[11px] text-text-faint`);
  });

  it("plain is opt-in — the default tag keeps its own surface", () => {
    h = mount(<Tag>main</Tag>);
    expect(tagEl(h).className).toContain(SURFACE);
  });

  it("size composes with tone rather than overriding it", () => {
    h = mount(<Tag size="sm" tone="accent" numeric>200k</Tag>);
    const cls = tagEl(h).className;
    expect(cls).toContain("h-5");
    expect(cls).toContain("text-accent-tx");
    expect(cls).toContain("tabular-nums");
  });

  it("renders the label and an optional icon slot", () => {
    h = mount(
      <Tag icon={<svg data-testid="ico" />}>
        <span className="truncate">feature/x</span>
      </Tag>,
    );
    expect(tagEl(h).textContent).toBe("feature/x");
    expect(h.container.querySelector('[data-testid="ico"]')).toBeTruthy();
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // @ts-expect-error — Tag must NOT accept className (M527 decision 3)
    void <Tag className="bg-red-500">x</Tag>;
    expect(true).toBe(true);
  });
});
