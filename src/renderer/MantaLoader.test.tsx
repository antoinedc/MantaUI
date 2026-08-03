// @vitest-environment jsdom
//
// Component tests for MantaLoader — the app's one waiting image on desktop
// (BET-649). The geometry is asserted against the NATIVE client's contract
// (mobile/native/MantaUI/MantaLoader.swift), because the whole point of the
// primitive is that both clients draw one image: a silent edit to an arc
// length, the inner ratio or a rotation class is a drift between them, and
// nothing else in the repo would catch it.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { MantaLoader, MantaMark } from "./MantaLoader";

/** The arc's share of its circle, recovered from the dash pattern. Recomputed
 *  here rather than imported so editing the component's constants fails. */
function arcFraction(el: Element): number {
  const r = Number(el.getAttribute("r"));
  const [on] = (el.getAttribute("stroke-dasharray") ?? "").split(" ").map(Number);
  return on / (2 * Math.PI * r);
}

describe("MantaLoader", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // @ts-expect-error — MantaLoader must NOT accept className (M527 decision 3)
    void <MantaLoader className="bg-red-500" />;
    expect(true).toBe(true);
  });

  it("draws the native client's two arcs: 28% outer, 22% inner", () => {
    h = mount(<MantaLoader />);
    const circles = h.container.querySelectorAll("circle");
    expect(circles.length).toBe(2);
    expect(arcFraction(circles[0])).toBeCloseTo(0.28, 3);
    expect(arcFraction(circles[1])).toBeCloseTo(0.22, 3);
  });

  it("puts the inner circle at 78% of the outer radius", () => {
    h = mount(<MantaLoader />);
    const [outer, inner] = h.container.querySelectorAll("circle");
    expect(Number(inner.getAttribute("r")) / Number(outer.getAttribute("r"))).toBeCloseTo(0.78, 3);
  });

  it("counter-rotates — the arcs carry two DIFFERENT animation classes", () => {
    // One class on both would read as a single spinning circle, which is the
    // thing the native comment says the counter-rotation exists to prevent.
    // Direction and speed live on these classes in index.css.
    h = mount(<MantaLoader />);
    const [outer, inner] = h.container.querySelectorAll("circle");
    expect(outer.getAttribute("class")).toBe("manta-loader-ring-out");
    expect(inner.getAttribute("class")).toBe("manta-loader-ring-in");
  });

  it("inline is 24px, screen is 92px", () => {
    h = mount(<MantaLoader />);
    expect((h.container.firstElementChild as HTMLElement).style.width).toBe("24px");
    h.unmount();
    h = mount(<MantaLoader size="screen" />);
    expect((h.container.firstElementChild as HTMLElement).style.width).toBe("92px");
  });

  it("pins the inline stroke at 2px instead of scaling it with the size", () => {
    // The optical adjustment: the screen form's 3/92 ratio held at 24px would
    // be a 0.8px hairline that disappears against the transcript.
    h = mount(<MantaLoader size="screen" />);
    expect(h.container.querySelector("circle")?.getAttribute("stroke-width")).toBe("3");
    h.unmount();
    h = mount(<MantaLoader />);
    expect(h.container.querySelector("circle")?.getAttribute("stroke-width")).toBe("2");
  });

  it("is decorative unless given a label", () => {
    h = mount(<MantaLoader />);
    expect(h.container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    h.unmount();
    h = mount(<MantaLoader size="screen" label="Connecting to session" />);
    const root = h.container.firstElementChild as HTMLElement;
    expect(root.getAttribute("role")).toBe("img");
    expect(root.getAttribute("aria-label")).toBe("Connecting to session");
    expect(root.getAttribute("aria-hidden")).toBe(null);
  });

  it("MantaMark is the same mark with no arcs — the finished-turn form", () => {
    h = mount(<MantaMark size={12} />);
    expect(h.container.querySelectorAll("circle").length).toBe(0);
    expect(h.container.querySelector("img")?.getAttribute("width")).toBe("12");
  });
});
