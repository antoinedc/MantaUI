// Pure HTTP byte-Range parsing for the /api/peek file-serving route —
// unit-testable with no HTTP, and the streaming code's single branch lives
// behind it (rather than three inline ones).
//
// parseByteRange(header, size) returns one of:
//   - { start, end }   a satisfiable single `bytes=start-end` range
//                      (inclusive byte offsets, clamped to the file size)
//   - "unsatisfiable"  a well-formed range that can never be satisfied
//                      (start at/past EOF, or a zero-length suffix range)
//   - null             no Range header, an unparseable header, or a
//                      multi-range request — the caller must serve the
//                      whole body as 200 (multi-range is deliberately not
//                      supported).

export function parseByteRange(header, size) {
  if (typeof header !== "string" || header.length === 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // non-bytes unit, multi-range (comma), or malformed
  const [, startStr, endStr] = m;

  if (startStr === "") {
    // Suffix range: bytes=-N → the last N bytes (RFC 7233 §2.1).
    const suffix = endStr === "" ? 0 : Number(endStr);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "unsatisfiable";
    const take = Math.min(suffix, size);
    if (take <= 0) return "unsatisfiable"; // empty file, or N === 0
    return { start: size - take, end: size - 1 };
  }

  const start = Number(startStr);
  if (!Number.isSafeInteger(start) || start < 0) return "unsatisfiable";
  if (start >= size) return "unsatisfiable"; // start past EOF

  if (endStr === "") {
    // Open-ended range: bytes=start- → to end of file.
    return { start, end: size - 1 };
  }

  const end = Number(endStr);
  if (!Number.isSafeInteger(end)) return "unsatisfiable";
  if (end < start) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}
