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

import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { isComposerControlTarget, InputArea } from "./InputArea";
import { mount } from "./testHarness";

// A full InputArea has ~40 props, nearly all inert scaffolding for any given
// assertion. `makeProps` supplies the quiet default (empty input, no running
// turn, no voice, no typeahead); a test overrides only what its assertion is
// about. Mirrors the SessionHeader mount helper's overrides pattern.
function makeProps(over: Partial<Parameters<typeof InputArea>[0]> = {}) {
  const setInput = vi.fn();
  const submit = vi.fn();
  const props = {
    input: "",
    setInput,
    inputRef: { current: null as HTMLTextAreaElement | null },
    submit,
    abort: vi.fn(),
    running: false,
    refreshing: false,
    attachments: [],
    onRemoveAttachment: vi.fn(),
    onAttachFiles: vi.fn(),
    pendingScreenshots: [],
    onAcceptScreenshots: vi.fn(),
    onDiscardScreenshot: vi.fn(),
    modelLabel: null,
    chatAutoAllow: false,
    setChatAutoAllow: vi.fn(),
    voice: {
      voiceEnabled: false,
      voiceRecording: false,
      voiceProcessing: false,
      voiceAnnouncement: "",
      voiceRecorder: {
        phase: "idle" as const,
        elapsedMs: 0,
        nearLimit: false,
        lastError: null,
        liveWindowRef: { current: null as Float32Array | null },
        start: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        send: vi.fn(),
        stop: vi.fn(),
        requestDiscard: vi.fn(),
        cancel: vi.fn(),
        discardArmed: false,
      },
    },
    models: null,
    modelOverride: null,
    defaultModel: null,
    activeProviderID: null,
    deactivatedMainModels: [],
    onOpenModels: vi.fn(),
    onSelectModel: vi.fn(),
    scheduleCount: 0,
    onSchedules: vi.fn(),
    onSecrets: vi.fn(),
    onWebhooks: vi.fn(),
    typeaheadOpen: false,
    typeaheadExactMatch: false,
    onTypeaheadConfirm: vi.fn(),
    onTypeaheadMove: vi.fn(),
    onTypeaheadCancel: vi.fn(),
    onHistoryUp: vi.fn(),
    onHistoryDown: vi.fn(),
    onQueuePop: vi.fn(),
    onPaste: vi.fn(),
    ...over,
  };
  return props;
}

// Empty-state suggestion chips (manta-forge S9): shown while the composer is
// empty, and each chip FILLS the input (setInput) without submitting.
describe("InputArea suggestion chips", () => {
  it("renders the suggestion chips while the composer is empty", () => {
    const h = mount(<InputArea {...makeProps()} />);
    expect(h.text()).toContain("Explain this codebase");
    expect(h.text()).toContain("What's the test setup?");
    h.unmount();
  });

  it("hides the suggestion chips once the composer has text", () => {
    const h = mount(<InputArea {...makeProps({ input: "hello" })} />);
    expect(h.text()).not.toContain("Explain this codebase");
    expect(h.text()).not.toContain("What's the test setup?");
    h.unmount();
  });

  it("fills the input on click without submitting (chips never auto-send)", () => {
    const setInput = vi.fn();
    const submit = vi.fn();
    const h = mount(<InputArea {...makeProps({ setInput, submit })} />);
    const buttons = h.container.querySelectorAll("button");
    const chip = Array.from(buttons).find((b) =>
      b.textContent?.includes("Explain this codebase"),
    );
    expect(chip).toBeTruthy();
    act(() => chip!.click());
    expect(setInput).toHaveBeenCalledWith("Explain this codebase");
    expect(submit).not.toHaveBeenCalled();
    h.unmount();
  });
});

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
