// pty.test.ts — tests for the pure PTY buffer logic.

import { describe, expect, it } from "vitest";
import {
  appendToBuffer,
  clearBuffer,
  createPtyBuffer,
  getVisibleLines,
} from "../pty";

describe("createPtyBuffer", () => {
  it("creates an empty buffer with default maxLines", () => {
    const buf = createPtyBuffer();
    expect(buf.lines).toEqual([]);
    expect(buf.currentLine).toBe("");
    expect(buf.maxLines).toBe(1000);
  });

  it("creates a buffer with custom maxLines", () => {
    const buf = createPtyBuffer(500);
    expect(buf.maxLines).toBe(500);
  });
});

describe("appendToBuffer", () => {
  it("appends a simple line", () => {
    const buf = createPtyBuffer(10);
    const next = appendToBuffer(buf, "hello\n");
    expect(next.lines).toEqual(["hello"]);
  });

  it("handles multiple lines", () => {
    const buf = createPtyBuffer(10);
    const next = appendToBuffer(buf, "line1\nline2\n");
    expect(next.lines).toEqual(["line1", "line2"]);
  });

  it("handles carriage return", () => {
    const buf = createPtyBuffer(10);
    // "abc\r" — \\r resets currentLine to "" (cursor moves to col 0)
    const next = appendToBuffer(buf, "abc\r");
    expect(next.currentLine).toBe("");
    expect(next.lines).toEqual([]);
  });

  it("handles carriage return followed by overwrite", () => {
    const buf = createPtyBuffer(10);
    // "abc\rdef\n" should result in "def" (\\r moves cursor to col 0, def overwrites)
    const next = appendToBuffer(buf, "abc\rdef\n");
    expect(next.lines).toEqual(["def"]);
    expect(next.currentLine).toBe("");
  });

  it("handles backspace", () => {
    const buf = createPtyBuffer(10);
    const next = appendToBuffer(buf, "ab\b c\n");
    // "ab" then backspace removes "b", then " c\n" → "a c"
    expect(next.lines).toEqual(["a c"]);
  });

  it("strips ANSI escape sequences", () => {
    const buf = createPtyBuffer(10);
    const next = appendToBuffer(buf, "\x1b[32mgreen\x1b[0m\n");
    expect(next.lines).toEqual(["green"]);
  });

  it("enforces maxLines", () => {
    const buf = createPtyBuffer(3);
    let next = buf;
    next = appendToBuffer(next, "line1\n");
    next = appendToBuffer(next, "line2\n");
    next = appendToBuffer(next, "line3\n");
    next = appendToBuffer(next, "line4\n");
    // Should only keep last 3 lines
    expect(next.lines).toEqual(["line2", "line3", "line4"]);
  });

  it("handles empty input", () => {
    const buf = createPtyBuffer(10);
    const next = appendToBuffer(buf, "");
    expect(next.lines).toEqual([]);
  });

  it("handles input without trailing newline", () => {
    const buf = createPtyBuffer(10);
    const next = appendToBuffer(buf, "partial");
    // Incomplete line goes to currentLine
    expect(next.currentLine).toBe("partial");
    expect(next.lines).toEqual([]);
  });
});

describe("clearBuffer", () => {
  it("clears all lines", () => {
    const buf = createPtyBuffer(10);
    const withLines = appendToBuffer(buf, "line1\nline2\n");
    const cleared = clearBuffer(withLines);
    expect(cleared.lines).toEqual([]);
    // maxLines is preserved
    expect(cleared.maxLines).toBe(10);
  });
});

describe("getVisibleLines", () => {
  it("returns all lines when fewer than rowCount", () => {
    const buf = createPtyBuffer(10);
    const withLines = appendToBuffer(buf, "line1\nline2\n");
    const visible = getVisibleLines(withLines, 10);
    expect(visible).toEqual(["line1", "line2"]);
  });

  it("returns only the last rowCount lines", () => {
    const buf = createPtyBuffer(100);
    let next = buf;
    for (let i = 0; i < 50; i++) {
      next = appendToBuffer(next, `line${i}\n`);
    }
    const visible = getVisibleLines(next, 10);
    expect(visible.length).toBe(10);
    // Should be the last 10 lines (line40 through line49)
    expect(visible[0]).toBe("line40");
    expect(visible[9]).toBe("line49");
  });

  it("returns empty array for empty buffer", () => {
    const buf = createPtyBuffer(10);
    const visible = getVisibleLines(buf, 10);
    expect(visible).toEqual([]);
  });
});
