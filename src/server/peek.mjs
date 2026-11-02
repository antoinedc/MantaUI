// File-peek handler for GET/HEAD /api/peek and the download handler for
// GET /api/download — extracted from index.mjs so the real route logic is
// unit-testable without a live HTTP server (the old peek.test.mjs used a
// re-implemented mock that silently drifted and hid a duplicated writeHead —
// BET-1146 review). All I/O is injected so a test can drive these exact
// handlers with real fs + a fake response.
//
// Both routes read through `openInHome` (homePath.mjs, the shared file-access
// policy) and stream from the handle it opened, so the file that was vetted is
// the file that is served. Failures are `{ error, reason }` with a safe literal
// (class 1, BET-1460) — raw error text never reaches the body.

import { extname, basename } from "node:path";
import { parseByteRange } from "./range.mjs";

// reason → [HTTP status, safe literal]. `reason` is also sent so the viewer can
// map it to its own state.
const REASON_RESPONSES = {
  missing: [404, "not found"],
  "outside-home": [403, "path outside home directory"],
  "not-file": [404, "not a file"],
  permission: [403, "permission denied"],
  changed: [503, "file changed while it was being opened"],
  unavailable: [503, "file unavailable"],
  invalid_input: [400, "invalid path"],
};

function writeJsonError(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

export function respondFsReason(res, reason) {
  const [status, error] = REASON_RESPONSES[reason] ?? REASON_RESPONSES.unavailable;
  writeJsonError(res, status, { error, reason: REASON_RESPONSES[reason] ? reason : "unavailable" });
}

// Headers are already sent by the time a stream can fail, so all that is left
// is to cut the connection; the raw error stays in the server log.
function failStream(res, route, e) {
  console.warn(`[api/${route}] stream failed:`, e?.message ?? e);
  if (!res.headersSent) respondFsReason(res, "unavailable");
  else res.destroy();
}

export function createPeekHandler({ openInHome, pipeline, MIME }) {
  return async function handlePeek(req, res, url) {
    const raw = url.searchParams.get("path") ?? "";
    if (!raw) {
      writeJsonError(res, 400, { error: "path is required" });
      return;
    }
    const opened = await openInHome(raw);
    if (!opened.ok) {
      respondFsReason(res, opened.reason);
      return;
    }
    const { handle, stat: s, abs } = opened;
    const ext = extname(abs);
    const contentType = MIME[ext] ?? "application/octet-stream";
    const baseHeaders = {
      "content-type": contentType,
      "accept-ranges": "bytes",
      "content-disposition": `inline; filename="${basename(abs).replace(/"/g, "")}"`,
    };
    const range = parseByteRange(req.headers.range ?? null, s.size);
    // Unsatisfiable range → 416 with `content-range: bytes */<size>`.
    if (range === "unsatisfiable") {
      await handle.close().catch(() => {});
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
        await handle.close().catch(() => {});
        res.end();
        return;
      }
      try {
        await pipeline(handle.createReadStream({ start: range.start, end: range.end }), res);
      } catch (e) {
        failStream(res, "peek", e);
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
      await handle.close().catch(() => {});
      res.end();
      return;
    }
    try {
      await pipeline(handle.createReadStream(), res);
    } catch (e) {
      failStream(res, "peek", e);
    }
  };
}

// Agent → device download: stream a file back to the device as a browser
// download. Same home-scoped rule as /api/peek (the outbox lives under home, so
// outbox toast Save + artifacts downloads are unaffected; inline media saved via
// media_show can sit anywhere in home). NON-destructive: the source is left in
// place; its lifetime is the artifact TTL, swept by `expireArtifacts`, not by a
// download. Re-download is always allowed.
export function createDownloadHandler({ openInHome, pipeline }) {
  return async function handleDownload(req, res, url) {
    const raw = url.searchParams.get("path") ?? "";
    if (!raw) {
      writeJsonError(res, 400, { error: "path is required" });
      return;
    }
    const opened = await openInHome(raw);
    if (!opened.ok) {
      respondFsReason(res, opened.reason);
      return;
    }
    const { handle, stat: s, abs } = opened;
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(s.size),
      "content-disposition": `attachment; filename="${basename(abs).replace(/"/g, "")}"`,
    });
    try {
      await pipeline(handle.createReadStream(), res);
    } catch (e) {
      failStream(res, "download", e);
    }
  };
}
