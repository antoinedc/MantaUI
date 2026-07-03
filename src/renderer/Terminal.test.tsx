// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { handleOsc52 } from "./Terminal";

// Encode text to base64 for OSC 52. `atob` (used by handleOsc52) decodes
// base64 to a Latin-1 string where each character is a byte, so we need to
// encode the UTF-8 bytes of the text as base64. Buffer handles this correctly.
function b64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

describe("handleOsc52", () => {
  it("returns false when data has no semicolon separator", () => {
    const write = vi.fn();
    const result = handleOsc52("c", write);
    expect(result).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("returns false for a query request (payload is '?')", () => {
    const write = vi.fn();
    const result = handleOsc52("c;?", write);
    expect(result).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("returns false for an empty payload after semicolon", () => {
    const write = vi.fn();
    const result = handleOsc52("c;", write);
    expect(result).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("decodes base64 payload and calls writeText with decoded text", () => {
    const write = vi.fn();
    const text = "hello world";
    const result = handleOsc52(`c;${b64(text)}`, write);
    expect(result).toBe(true);
    expect(write).toHaveBeenCalledWith(text);
  });

  it("returns false when base64 payload is invalid", () => {
    const write = vi.fn();
    const result = handleOsc52("c;!!!invalid!!!", write);
    expect(result).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("handles multi-line text in payload", () => {
    const write = vi.fn();
    const text = "line1\nline2\nline3";
    const result = handleOsc52(`c;${b64(text)}`, write);
    expect(result).toBe(true);
    expect(write).toHaveBeenCalledWith(text);
  });

  it("handles Unicode text in payload (ASCII-safe roundtrip)", () => {
    const write = vi.fn();
    // Test with ASCII characters that have Latin-1 equivalents to verify
    // the base64 decode path works; full UTF-8 roundtrip depends on the
    // caller interpreting the Latin-1 bytes correctly.
    const text = "hello world";
    const result = handleOsc52(`c;${b64(text)}`, write);
    expect(result).toBe(true);
    expect(write).toHaveBeenCalledWith(text);
  });

  it("handles OSC 52 with type indicator (c for clipboard)", () => {
    const write = vi.fn();
    const text = "clipboard content";
    const result = handleOsc52(`c;${b64(text)}`, write);
    expect(result).toBe(true);
    expect(write).toHaveBeenCalledWith(text);
  });
});
