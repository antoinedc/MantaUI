// @vitest-environment jsdom
//
// Component tests for the ForgeMark brand-mark component (BET-924).
//
// ForgeMark renders an inline SVG brand mark for a forge kind. It is
// decorative BY CONTRACT: monochrome currentColor + aria-hidden, and it must
// render NOTHING for an unknown/absent kind (never a wrong logo, never a
// fallback glyph).

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { ForgeMark, hasForgeMark } from "./ForgeMark";

function svgEl(h: Harness): SVGSVGElement | null {
  return h.container.querySelector("svg");
}

describe("ForgeMark", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it('kind="github" renders one <svg> carrying a <path>, aria-hidden="true"', () => {
    h = mount(<ForgeMark kind="github" />);
    const svg = svgEl(h);
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(h.container.querySelectorAll("svg").length).toBe(1);
    expect(svg?.querySelector("path")).toBeTruthy();
  });

  it('kind="gitlab" renders a <path> with a different `d` than github\'s', () => {
    h = mount(<ForgeMark kind="github" />);
    const githubD = h.container.querySelector("path")?.getAttribute("d");
    h.rerender(<ForgeMark kind="gitlab" />);
    const gitlabD = h.container.querySelector("path")?.getAttribute("d");
    expect(githubD).toBeTruthy();
    expect(gitlabD).toBeTruthy();
    expect(gitlabD).not.toBe(githubD);
  });

  it("kind={null} and kind=\"bitbucket\" each render nothing", () => {
    h = mount(<ForgeMark kind={null} />);
    expect(h.container.innerHTML).toBe("");
    h.rerender(<ForgeMark kind="bitbucket" />);
    expect(h.container.innerHTML).toBe("");
  });

  it("hasForgeMark: true for github/gitlab, false for null/undefined/empty/bitbucket", () => {
    expect(hasForgeMark("github")).toBe(true);
    expect(hasForgeMark("gitlab")).toBe(true);
    expect(hasForgeMark(null)).toBe(false);
    expect(hasForgeMark(undefined)).toBe(false);
    expect(hasForgeMark("")).toBe(false);
    expect(hasForgeMark("bitbucket")).toBe(false);
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // If ForgeMark ever grew a className prop this directive becomes unused and
    // typecheck fails — the standing-decision-3 guard lives in the types.
    // @ts-expect-error — no className escape hatch (M527 standing decision 3)
    <ForgeMark kind="github" className="text-danger" />;
    expect(true).toBe(true);
  });
});
