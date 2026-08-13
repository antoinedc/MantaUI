// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FLASH_MS,
  FLASH_POLL_MS,
  FLASH_WAIT_MS,
  flashMessageRow,
} from "./messageFlash";

const CLASS = "manta-message-flash";

function row(messageId: string): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute("data-message-id", messageId);
  return el;
}

describe("flashMessageRow", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("flashes synchronously when the row is already in the DOM", () => {
    const el = row("m1");
    document.body.appendChild(el);
    flashMessageRow("m1");
    expect(el.classList.contains(CLASS)).toBe(true);
  });

  it("flashes a LATE-appearing row once it is mounted", () => {
    flashMessageRow("m1");
    expect(document.querySelector(`[data-message-id="m1"]`)).toBeNull();
    const el = row("m1");
    document.body.appendChild(el);
    vi.advanceTimersByTime(FLASH_POLL_MS);
    expect(el.classList.contains(CLASS)).toBe(true);
  });

  it("removes the class FLASH_MS after it was applied (not after the call)", () => {
    const el = row("m1");
    document.body.appendChild(el);
    flashMessageRow("m1");
    expect(el.classList.contains(CLASS)).toBe(true);
    vi.advanceTimersByTime(FLASH_MS - 1);
    expect(el.classList.contains(CLASS)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.classList.contains(CLASS)).toBe(false);
  });

  it("gives up after FLASH_WAIT_MS when the row never appears, leaving no timers", () => {
    flashMessageRow("m1");
    expect(document.querySelector(`[data-message-id="m1"]`)).toBeNull();
    vi.advanceTimersByTime(FLASH_WAIT_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(document.querySelector(`[data-message-id="m1"]`)).toBeNull();
  });

  it("cancelling stops a pending wait (a late row is never flashed)", () => {
    const cancel = flashMessageRow("m1");
    cancel();
    document.body.appendChild(row("m1"));
    vi.advanceTimersByTime(FLASH_WAIT_MS);
    const el = document.querySelector<HTMLElement>(`[data-message-id="m1"]`);
    expect(el).not.toBeNull();
    expect(el!.classList.contains(CLASS)).toBe(false);
  });

  it("cancelling removes an already-applied class", () => {
    const el = row("m1");
    document.body.appendChild(el);
    const cancel = flashMessageRow("m1");
    expect(el.classList.contains(CLASS)).toBe(true);
    cancel();
    expect(el.classList.contains(CLASS)).toBe(false);
  });
});
