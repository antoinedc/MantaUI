// pty.ts — pure PTY buffer logic for the React Native terminal.
//
// Manages a scrollback buffer with ANSI escape sequence handling. The buffer
// is a simple array of strings (one per line), with a max height. ANSI escape
// sequences (cursor movement, clear screen, etc.) are stripped for display.
//
// ALL logic is pure (no I/O, no React) so it's unit-testable. The TerminalScreen
// component owns the WebSocket + render.

export interface PtyBuffer {
  /** Current lines in the buffer (complete lines ended with \n). */
  lines: string[];
  /** The current incomplete line (no trailing \n yet). */
  currentLine: string;
  /** Maximum number of lines to keep (scrollback). */
  maxLines: number;
}

/** Create a new empty PTY buffer. */
export function createPtyBuffer(maxLines: number = 1000): PtyBuffer {
  return { lines: [], currentLine: "", maxLines };
}

/**
 * Append raw PTY output to the buffer. Strips ANSI escape sequences and handles
 * basic control characters (newline, carriage return, backspace).
 *
 * ANSI sequences are stripped by removing everything matching \x1b\[[0-9;]*[a-zA-Z].
 * Control characters: \n → new line, \r → carriage return (move to start of line),
 * \b → backspace (remove last char).
 */
export function appendToBuffer(buffer: PtyBuffer, raw: string): PtyBuffer {
  // Strip ANSI escape sequences
  const cleaned = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

  // Start with the buffer's current incomplete line
  let currentLine = buffer.currentLine;
  const newLines: string[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (char === "\n") {
      // Newline: push current line (complete) and start a new one
      newLines.push(currentLine);
      currentLine = "";
    } else if (char === "\r") {
      // Carriage return: move cursor to column 0, overwrite from there
      currentLine = "";
    } else if (char === "\b") {
      // Backspace: remove last character from current line
      currentLine = currentLine.slice(0, -1);
    } else {
      // Regular character: append to current line
      currentLine += char;
    }
  }

  // Combine existing lines with new complete lines
  let lines = [...buffer.lines, ...newLines];

  // Enforce maxLines
  if (lines.length > buffer.maxLines) {
    lines = lines.slice(lines.length - buffer.maxLines);
  }

  return { lines, currentLine, maxLines: buffer.maxLines };
}

/**
 * Clear the buffer (handle \x1b[2J or \x1b[3J — clear screen / clear entire
 * scrollback).
 */
export function clearBuffer(buffer: PtyBuffer): PtyBuffer {
  return { lines: [], currentLine: "", maxLines: buffer.maxLines };
}

/**
 * Get the visible lines for rendering (last `rowCount` lines, excluding empty currentLine).
 */
export function getVisibleLines(buffer: PtyBuffer, rowCount: number): string[] {
  // Only include currentLine if it has content (otherwise we'd show an extra empty line)
  const allLines = buffer.currentLine.length > 0
    ? [...buffer.lines, buffer.currentLine]
    : [...buffer.lines];
  if (allLines.length <= rowCount) {
    return allLines;
  }
  return allLines.slice(allLines.length - rowCount);
}
