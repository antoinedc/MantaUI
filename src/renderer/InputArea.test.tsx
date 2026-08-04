// @vitest-environment jsdom
//
// isComposerControlTarget — the predicate behind the composer box's
// click-to-focus routing.
//
// On Windows a click inside the composer box could leave the <textarea>
// unfocused: the box lit its `:focus-within` ring (so the click resolved to
// SOME descendant) but no caret appeared and the field could not be typed
// into, while every other input in the app worked. InputArea now routes
// non-control clicks in the box to the message field explicitly instead of
// trusting the browser's own resolution. This predicate is the escape hatch
// that keeps the real controls clickable — the half that is easy to get
// wrong, since a too-broad rule would swallow the Send button's click.

import { describe, it, expect } from "vitest";
import { isComposerControlTarget } from "./InputArea";

/** Build a detached composer-box-shaped tree and hand back its parts. */
function box() {
  const root = document.createElement("div");
  root.className = "manta-composer-input-row";
  root.innerHTML = `
    <div class="strip"><button class="chip-remove"><svg class="chip-icon"></svg></button></div>
    <div class="row">
      <textarea class="field"></textarea>
      <button class="send"><svg class="send-icon"></svg></button>
    </div>
    <a class="link">docs</a>
    <div class="fake-button" role="button"><span class="fake-label">x</span></div>
  `;
  const q = (sel: string) => root.querySelector(sel) as Element;
  return {
    root,
    field: q("textarea.field"),
    row: q(".row"),
    send: q("button.send"),
    sendIcon: q(".send-icon"),
    chipRemove: q("button.chip-remove"),
    chipIcon: q(".chip-icon"),
    link: q("a.link"),
    roleButton: q(".fake-button"),
    roleButtonLabel: q(".fake-label"),
  };
}

describe("isComposerControlTarget", () => {
  it("does NOT claim the text field — a click there must reach the composer's focus routing", () => {
    expect(isComposerControlTarget(box().field)).toBe(false);
  });

  it("does NOT claim the box's own padding/chrome — that is what routes focus to the field", () => {
    const b = box();
    expect(isComposerControlTarget(b.root)).toBe(false);
    expect(isComposerControlTarget(b.row)).toBe(false);
  });

  it("claims the Send button, so its click is not swallowed by the focus routing", () => {
    expect(isComposerControlTarget(box().send)).toBe(true);
  });

  it("claims a click on an icon INSIDE a control (the common real-world hit)", () => {
    // Pointer events land on the <svg>, not the <button> — the predicate must
    // walk up, or clicking the Send glyph would focus the field instead.
    const b = box();
    expect(isComposerControlTarget(b.sendIcon)).toBe(true);
    expect(isComposerControlTarget(b.chipIcon)).toBe(true);
  });

  it("claims an attachment chip's remove button", () => {
    expect(isComposerControlTarget(box().chipRemove)).toBe(true);
  });

  it("claims links and role=button controls", () => {
    const b = box();
    expect(isComposerControlTarget(b.link)).toBe(true);
    expect(isComposerControlTarget(b.roleButton)).toBe(true);
    expect(isComposerControlTarget(b.roleButtonLabel)).toBe(true);
  });

  it("is null/non-Element safe — the handler passes a raw EventTarget", () => {
    expect(isComposerControlTarget(null)).toBe(false);
    expect(isComposerControlTarget(new EventTarget())).toBe(false);
  });
});
