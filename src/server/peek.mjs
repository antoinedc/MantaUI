// File-peek handler for GET/HEAD /api/peek — extracted from index.mjs so the
// real route logic is unit-testable without a live HTTP server (the old
// peek.test.mjs used a re-implemented mock that silently drifted and hid a
// duplicated writeHead — BET-1146 review). All I/O is injected so a test can
// drive this exact handler with real fs + a fake response.

import { resolve, extname, basename } from "node:path";
import { parseByteRange } from "./range.mjs";

export function createPeekHandler({ homedir, stat, createReadStream, pipeline, MIME }) {
  function writeJsonError(res, status, obj) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  }

  return async function handlePeek(req, res, url) {
    const raw = url.searchParams.get("path") ?? "";
    if (!raw) {
      writeJsonError(res, 400, { error: "path is required" });
      return;
    }
    // Expand ~ to $HOME so callers can pass ~/foo/bar.
    let resolved = raw;
    if (resolved === "~") resolved = homedir() + "/";
    else if (resolved.startsWith("~/")) resolved = homedir() + resolved.slice(1);
    else resolved = resolve(resolved);
    // Guard: resolved path must stay inside the user's home dir.
    const home = homedir() + "/";
    if (resolved !== home && !resolved.startsWith(home)) {
      writeJsonError(res, 403, { error: "path outside home directory" });
      return;
    }
    let s;
    try {
      s = await stat(resolved);
    } catch (e) {
      if (e?.code === "ENOENT") {
        writeJsonError(res, 404, { error: "not found" });
        return;
      }
      writeJsonError(res, 500, { error: String(e?.message ?? e) });
      return;
    }
    if (!s.isFile()) {
      writeJsonError(res, 404, { error: "not a file" });
      return;
    }
    const ext = extname(resolved);
    const contentType = MIME[ext] ?? "application/octet-stream";
    const baseHeaders = {
      "content-type": contentType,
      "accept-ranges": "bytes",
      "content-disposition": `inline; filename="${basename(resolved).replace(/"/g, "")}"`,
    };
    const range = parseByteRange(req.headers.range ?? null, s.size);
    // Unsatisfiable range → 416 with `content-range: bytes */<size>`.
    if (range === "unsatisfiable") {
      res.writeHead(416, {
        ...baseHeaders,
        "content-range": `bytes */${s.size}`,
      });
      res.end();
      return;
    }
    // Satisfiable single range → 206, streaming only that slice.
    if (range) {
      const length = range.end - range.start + 1;
      res.writeHead(206, {
        ...baseHeaders,
        "content-range": `bytes ${range.start}-${range.end}/${s.size}`,
        "content-length": String(length),
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      try {
        await pipeline(
          createReadStream(resolved, { start: range.start, end: range.end }),
          res,
        );
      } catch (e) {
        if (!res.headersSent) {
          writeJsonError(res, 500, { error: String(e?.message ?? e) });
        } else {
          res.destroy();
        }
      }
      return;
    }
    // Absent, unparseable, or multi-range header → exactly today's 200
    // behaviour, byte for byte. Multi-range is deliberately not supported.
    res.writeHead(200, {
      ...baseHeaders,
      "content-length": String(s.size),
    });
    // HEAD reports the size via `content-length` without streaming the body.
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    try {
      await pipeline(createReadStream(resolved), res);
    } catch (e) {
      if (!res.headersSent) {
        writeJsonError(res, 500, { error: String(e?.message ?? e) });
      } else {
        res.destroy();
      }
    }
  };
}
